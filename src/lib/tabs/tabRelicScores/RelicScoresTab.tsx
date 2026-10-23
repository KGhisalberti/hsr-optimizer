import {
  Badge,
  Flex,
  Text,
} from '@mantine/core'
import {
  type ColDef,
  type GetRowIdParams,
} from 'ag-grid-community'
import {
  AgGridReact,
  type CustomCellRendererProps,
} from 'ag-grid-react'
import chroma from 'chroma-js'
import type { TFunction } from 'i18next'
import {
  Parts,
  type StatsValues,
} from 'lib/constants/constants'
import { RELICS_TAB_WIDTH } from 'lib/constants/constantsUi'
import { RelicScorer } from 'lib/relics/scoring/relicScorer'
import { pctToRating } from 'lib/relics/scoring/scoreFormatting'
import { hasMainStat } from 'lib/relics/scoring/substatScoring'
import type {
  RelicScoringResult,
  ScorerMetadata,
} from 'lib/relics/scoring/types'
import { Assets } from 'lib/rendering/assets'

import { useGlobalStore } from 'lib/stores/app/appStore'
import { useCharacterStore } from 'lib/stores/character/characterStore'
import { useRelicStore } from 'lib/stores/relic/relicStore'
import { useScoringStore } from 'lib/stores/scoring/scoringStore'
import { AppPages } from 'lib/tabs/navigation/constants'
import {
  type SimulatedMainStatUpgrade,
  simulateMainStatUpgrades,
} from 'lib/tabs/tabRelicScores/relicScoresSimulation'
import { truncate10ths } from 'lib/utils/mathUtils'
import {
  useEffect,
  useMemo,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import type {
  Character,
  CharacterId,
} from 'types/character'
import type { Relic } from 'types/relic'

const PART_ORDER = [Parts.Head, Parts.Hands, Parts.Body, Parts.Feet, Parts.PlanarSphere, Parts.LinkRope] as const

// Below an A rating, a relic is worth replacing
const CHANGE_BELOW_PCT = 40
// Minimum expected gain from reroll dice to suggest it (one rating tier)
const REROLL_MIN_GAIN_PCT = 5

type ChangeReason = 'EmptySlot' | 'NotFiveStar' | 'WrongMainStat' | 'LowScore'
type ChangeSuggestion = { part: Parts, pct: number | null, reason: ChangeReason }
type RerollSuggestion = { part: Parts, gainPct: number }
type MainStatSuggestion = { part: Parts, current: StatsValues, ideal: StatsValues[] }
type NextTarget = { part: Parts, pct: number }

type RelicScoreRow = {
  characterId: CharacterId,
  relics: Record<Parts, Relic | null>,
  scores: Record<Parts, RelicScoringResult | null>,
  totalPct: number,
  totalRating: string,
  toChange: ChangeSuggestion[],
  toReroll: RerollSuggestion[],
  betterMainStat: MainStatSuggestion[],
}

// undefined: not started yet, null: no DPS simulation for this character
type SimulationState = SimulatedMainStatUpgrade[] | null | 'pending' | undefined

type RelicScoreGridRow = RelicScoreRow & { simulation: SimulationState }

// Usable main stat that still isn't one of the character's recommended ones (e.g. HP% sphere instead of Ice DMG)
function suboptimalMainStat(part: Parts, relic: Relic, meta: ScorerMetadata | undefined): MainStatSuggestion | null {
  if (!meta || !hasMainStat(part)) return null
  const ideal = meta.parts[part]
  const mainStat = relic.main.stat
  if (ideal.length === 0 || ideal.includes(mainStat) || (meta.stats[mainStat] ?? 0) >= 1) return null
  return { part, current: mainStat, ideal }
}

function scoreCharacters(characters: Character[], relicsById: Partial<Record<string, Relic>>): RelicScoreRow[] {
  const scorer = new RelicScorer()

  return characters.map((character) => {
    const relics = {} as Record<Parts, Relic | null>
    const scores = {} as Record<Parts, RelicScoringResult | null>
    const toChange: ChangeSuggestion[] = []
    const toReroll: RerollSuggestion[] = []
    const betterMainStat: MainStatSuggestion[] = []
    let sum = 0
    for (const part of PART_ORDER) {
      const relic = relicsById[character.equipped?.[part] ?? ''] ?? null
      const result = relic ? scorer.getCurrentRelicScore(relic, character.id) : null
      relics[part] = relic
      scores[part] = result
      sum += result?.percentScore ?? 0

      if (!relic || !result) {
        toChange.push({ part, pct: null, reason: 'EmptySlot' })
        continue
      }

      // '?' means a non 5★ relic or a useless main stat: reroll dice can't fix either
      if (result.rating === '?') {
        toChange.push({ part, pct: result.percentScore, reason: relic.grade === 5 ? 'WrongMainStat' : 'NotFiveStar' })
        continue
      }

      // Same measure as the Relics tab "Δ Reroll Avg" column
      const potential = scorer.scoreRelicPotential(relic, character.id)
      const rerollGain = potential.rerollAvgPct > 0 ? potential.rerollAvgPct - potential.averagePct : 0
      const rerollWorthIt = rerollGain >= REROLL_MIN_GAIN_PCT

      if (result.percentScore < CHANGE_BELOW_PCT && !(rerollWorthIt && potential.rerollAvgPct >= CHANGE_BELOW_PCT)) {
        toChange.push({ part, pct: result.percentScore, reason: 'LowScore' })
        // Already being replaced, no need to also mention its main stat
        continue
      }
      if (rerollWorthIt) {
        toReroll.push({ part, gainPct: truncate10ths(rerollGain) })
      }

      // Reroll dice don't touch the main stat, so this is listed on its own
      const mainStatSuggestion = suboptimalMainStat(part, relic, result.meta)
      if (mainStatSuggestion) betterMainStat.push(mainStatSuggestion)
    }

    // Empty slots first, then worst score first; biggest reroll gain first
    toChange.sort((a, b) => (a.pct ?? -1) - (b.pct ?? -1))
    toReroll.sort((a, b) => b.gainPct - a.gainPct)

    // Empty slots count as 0 so an incomplete build ranks below a complete one
    const totalPct = truncate10ths(sum / PART_ORDER.length)
    return {
      characterId: character.id,
      relics,
      scores,
      totalPct,
      totalRating: pctToRating(totalPct),
      toChange,
      toReroll,
      betterMainStat,
    }
  })
}

// When nothing needs replacing, still point at the weakest relic not already mentioned
function findNextTarget(row: RelicScoreRow, mentioned: Set<Parts>): NextTarget | null {
  if (row.toChange.length > 0) return null
  let nextTarget: NextTarget | null = null
  for (const part of PART_ORDER) {
    const pct = row.scores[part]?.percentScore
    if (pct == null || mentioned.has(part)) continue
    if (!nextTarget || pct < nextTarget.pct) nextTarget = { part, pct }
  }
  return nextTarget
}

/**
 * Runs the DPS simulations one character at a time while the tab is open, so the table fills in
 * progressively without flooding the simulation workers.
 */
function useMainStatSimulations(characters: Character[], relicsById: Partial<Record<string, Relic>>, enabled: boolean) {
  const [results, setResults] = useState<Partial<Record<CharacterId, SimulationState>>>({})

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    setResults(Object.fromEntries(characters.map((c) => [c.id, 'pending'])))

    void (async () => {
      for (const character of characters) {
        if (cancelled) return
        let result: SimulatedMainStatUpgrade[] | null = null
        try {
          result = await simulateMainStatUpgrades(character, relicsById)
        } catch (error) {
          console.error(`Relic scores: DPS simulation failed for ${character.id}`, error)
        }
        if (cancelled) return
        setResults((prev) => ({ ...prev, [character.id]: result }))
      }
    })()

    return () => {
      cancelled = true
    }
  }, [characters, relicsById, enabled])

  return results
}

// Same look as the Relics tab grid: balham dark theme, small headers, theme gradient on score cells
const defaultColDef: ColDef<RelicScoreGridRow> = {
  sortable: true,
  headerClass: 'relicsTableHeader',
  sortingOrder: ['desc', 'asc', null],
  wrapHeaderText: true,
  autoHeaderHeight: true,
  suppressHeaderMenuButton: true,
  suppressMovable: true,
}

const LEFT_ALIGNED = { justifyContent: 'flex-start' }

// Red → yellow → green along the rating tiers (40% = A, 70% = SSS)
const scoreColorScale = chroma.scale(['#df524b99', '#efe95999', '#89d86d99']).domain([0, 40, 70])

// Goes through --cell-bg so the grid's hover/selection tints still layer on top
function scoreCellStyle(pct: number | null | undefined) {
  if (pct == null) return
  return { '--cell-bg': scoreColorScale(pct).css() }
}

const CHARACTER_WIDTH = 190
const PART_WIDTH = 115
const TOTAL_WIDTH = 95
// Fills the rest of the grid; 2px for the grid border
const SUMMARY_WIDTH = RELICS_TAB_WIDTH - CHARACTER_WIDTH - PART_ORDER.length * PART_WIDTH - TOTAL_WIDTH - 2

function generateColumnDefs(t: TFunction<['relicsTab', 'common']>): ColDef<RelicScoreGridRow>[] {
  return [
    {
      colId: 'character',
      headerName: t('RelicScores.Character'), /* Character */
      width: CHARACTER_WIDTH,
      sortable: false,
      cellRenderer: CharacterCell,
      cellStyle: LEFT_ALIGNED,
    },
    ...PART_ORDER.map((part): ColDef<RelicScoreGridRow> => ({
      colId: part,
      headerName: t(`common:ReadableParts.${part}`),
      width: PART_WIDTH,
      valueGetter: (params) => params.data?.scores[part]?.percentScore ?? null,
      cellStyle: (params) => scoreCellStyle(params.value),
      cellRenderer: RelicScoreCell,
      cellRendererParams: { part },
    })),
    {
      colId: 'total',
      field: 'totalPct',
      headerName: t('RelicScores.Total'), /* Total */
      width: TOTAL_WIDTH,
      cellStyle: (params) => scoreCellStyle(params.value),
      cellRenderer: TotalCell,
    },
    {
      colId: 'summary',
      headerName: t('RelicScores.Summary.Header'), /* Summary */
      // Fixed width like the Relics grid: the tab mounts hidden, so flex sizing would start from 0
      width: SUMMARY_WIDTH,
      sortable: false,
      autoHeight: true,
      cellRenderer: SummaryCell,
      cellStyle: { ...LEFT_ALIGNED, padding: '4px 8px' },
    },
  ]
}

const getRowId = (params: GetRowIdParams<RelicScoreGridRow>) => params.data.characterId

export function RelicScoresTab() {
  const { t } = useTranslation(['relicsTab', 'common'])
  const characters = useCharacterStore((s) => s.characters)
  const relicsById = useRelicStore((s) => s.relicsById)
  // Custom scoring weights change the scores, so recompute when they change
  const scoringOverrides = useScoringStore((s) => s.scoringMetadataOverrides)
  // Simulations are expensive, so only start them once the page is actually opened
  const isActive = useGlobalStore((s) => s.activeKey === AppPages.RELIC_SCORES)
  const [wasOpened, setWasOpened] = useState(isActive)
  if (isActive && !wasOpened) setWasOpened(true)
  const simulations = useMainStatSimulations(characters, relicsById, wasOpened)

  const rows = useMemo(
    () => scoreCharacters(characters, relicsById),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [characters, relicsById, scoringOverrides],
  )

  const rowData = useMemo<RelicScoreGridRow[]>(
    () => rows.map((row) => ({ ...row, simulation: simulations[row.characterId] })),
    [rows, simulations],
  )

  const columnDefs = useMemo(() => generateColumnDefs(t), [t])

  return (
    <Flex direction='column' gap={8} style={{ width: RELICS_TAB_WIDTH, marginBottom: 200 }}>
      <Text size='xl' fw={700}>{t('RelicScores.Title') /* Relic scores by character */}</Text>
      <Text size='sm' c='dimmed'>
        {
          t(
            'RelicScores.Description',
          ) /* Current substat score of each equipped relic, using each character's scoring weights. Click a column header to sort. */
        }
      </Text>

      {rows.length === 0
        ? <Text>{t('RelicScores.Empty') /* No characters yet. Import your data or add characters to see their relic scores. */}</Text>
        : (
          <div id='relicScoresGrid' className='ag-theme-balham-dark' style={{ width: '100%' }}>
            <AgGridReact<RelicScoreGridRow>
              rowData={rowData}
              columnDefs={columnDefs}
              defaultColDef={defaultColDef}
              getRowId={getRowId}
              domLayout='autoHeight'
              rowHeight={36}
              headerHeight={36}
              suppressCellFocus={true}
              animateRows={true}
            />
          </div>
        )}
    </Flex>
  )
}

function CharacterCell({ data }: CustomCellRendererProps<RelicScoreGridRow>) {
  const { t } = useTranslation('gameData')
  if (!data) return null
  return (
    <Flex align='center' gap={8} style={{ paddingLeft: 10 }}>
      <img src={Assets.getCharacterAvatarById(data.characterId)} style={{ width: 28, height: 28 }} loading='lazy' />
      <Text size='sm'>{t(`Characters.${data.characterId}.LongName`)}</Text>
    </Flex>
  )
}

function RelicScoreCell({ data, part }: CustomCellRendererProps<RelicScoreGridRow> & { part: Parts }) {
  const relic = data?.relics[part]
  const result = data?.scores[part]
  if (!relic || !result) return <Text size='sm' c='dimmed'>—</Text>
  return (
    <Flex align='center' gap={6}>
      <img src={Assets.getSetImage(relic.set, relic.part)} style={{ width: 26, height: 26 }} loading='lazy' />
      <ScoreText rating={result.rating} pct={result.percentScore} />
    </Flex>
  )
}

function TotalCell({ data }: CustomCellRendererProps<RelicScoreGridRow>) {
  if (!data) return null
  return <ScoreText rating={data.totalRating} pct={data.totalPct} bold />
}

function ScoreText({ rating, pct, bold }: { rating: string, pct: number, bold?: boolean }) {
  return (
    <Text size='sm' fw={bold ? 700 : 500}>
      {rating} <Text span size='xs'>{pct.toFixed(1)}%</Text>
    </Text>
  )
}

function SummaryCell({ data }: CustomCellRendererProps<RelicScoreGridRow>) {
  const { t } = useTranslation(['relicsTab', 'common'])
  if (!data) return null

  const { toChange, toReroll, simulation } = data
  const partName = (part: Parts) => t(`common:ReadableParts.${part}`)
  const statName = (stat: StatsValues) => t(`common:ReadableStats.${stat}`)

  // Simulated swaps are more precise than the scoring metadata check, so they win for their slot.
  // Slots already marked for replacement are skipped: the new relic can come with the right main stat.
  const simulated = Array.isArray(simulation)
    ? simulation.filter((x) => !toChange.some((c) => c.part === x.part))
    : []
  const simulatedParts = new Set<Parts>(simulated.map((x) => x.part))
  const betterMainStat = data.betterMainStat.filter((x) => !simulatedParts.has(x.part))

  const mentioned = new Set<Parts>([...toReroll.map((x) => x.part), ...betterMainStat.map((x) => x.part), ...simulatedParts])
  const nextTarget = findNextTarget(data, mentioned)

  const hasSuggestion = toChange.length > 0 || toReroll.length > 0 || betterMainStat.length > 0 || simulated.length > 0 || nextTarget
  const pending = simulation === 'pending'

  if (!hasSuggestion && !pending) {
    return <Text size='sm' c='dimmed'>{t('RelicScores.Summary.NothingToDo') /* Nothing to improve */}</Text>
  }

  return (
    <Flex direction='column' gap={4} style={{ width: '100%' }}>
      <SuggestionLine
        label={t('RelicScores.Summary.Change') /* Change: */}
        color='red'
        items={toChange.map(({ part, pct, reason }) =>
          `${partName(part)} · ${reason === 'LowScore' ? `${pct?.toFixed(1)}%` : t(`RelicScores.Summary.${reason}`)}`
        )}
      />
      <SuggestionLine
        label={t('RelicScores.Summary.Reroll') /* Reroll: */}
        color='green'
        items={toReroll.map(({ part, gainPct }) => `${partName(part)} · +${gainPct.toFixed(1)}%`)}
      />
      <SuggestionLine
        label={t('RelicScores.Summary.MainStat') /* Main stat: */}
        color='orange'
        items={[
          ...simulated.map(({ part, current, best, damageGainPct }) =>
            `${partName(part)} · ${statName(current)} → ${statName(best)} (${t('RelicScores.Summary.DamageGain', { gain: damageGainPct.toFixed(1) })})`
          ),
          ...betterMainStat.map(({ part, current, ideal }) => `${partName(part)} · ${statName(current)} → ${ideal.map(statName).join(' / ')}`),
        ]}
      />
      {nextTarget && (
        <SuggestionLine
          label={t('RelicScores.Summary.NextTarget') /* Next upgrade: */}
          color='blue'
          items={[`${partName(nextTarget.part)} · ${nextTarget.pct.toFixed(1)}%`]}
        />
      )}
      {pending && <Text size='xs' c='dimmed'>{t('RelicScores.Summary.Simulating') /* Simulating main stats… */}</Text>}
    </Flex>
  )
}

function SuggestionLine({ label, color, items }: { label: string, color: string, items: string[] }) {
  if (items.length === 0) return null
  return (
    <Flex align='center' gap={4} wrap='wrap'>
      <Text size='xs' fw={700}>{label}</Text>
      {items.map((item) => (
        <Badge key={item} color={color} variant='light' size='sm' tt='none'>
          {item}
        </Badge>
      ))}
    </Flex>
  )
}
