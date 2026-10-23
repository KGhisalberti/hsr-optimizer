import { type PreviewRelics } from 'lib/characterPreview/characterPreviewController'
import { resolveShowcaseScoringData } from 'lib/characterPreview/showcaseDerivedData'
import { sharedSimResultComparator } from 'lib/characterPreview/summary/DpsScoreMainStatUpgradesTable'
import {
  type MainStatParts,
  Parts,
  Stats,
  type StatsValues,
} from 'lib/constants/constants'
import {
  computeScoringCacheKey,
  requestScoreUpgrades,
} from 'lib/scoring/scoringService'
import { useShowcaseTabStore } from 'lib/tabs/tabShowcase/useShowcaseTabStore'
import type { Character } from 'types/character'
import {
  type ScoringConfig,
  ScoringConfigType,
} from 'types/metadata'
import type { Relic } from 'types/relic'

// Ignore swaps that barely move the needle
const MIN_DAMAGE_GAIN_PCT = 1

export type SimulatedMainStatUpgrade = {
  part: MainStatParts,
  current: StatsValues,
  best: StatsValues,
  damageGainPct: number,
}

export function getPreviewRelics(character: Character, relicsById: Partial<Record<string, Relic>>): PreviewRelics {
  const relics = {} as PreviewRelics
  for (const part of Object.values(Parts)) {
    relics[part] = relicsById[character.equipped?.[part] ?? ''] ?? null
  }
  return relics
}

/**
 * Runs the same DPS Score simulation as the Showcase tab (same team and options) and returns,
 * for each slot, the main stat swap that adds the most damage. Results are cached by the scoring
 * service, so re-running for an unchanged character is instant.
 * Resolves to null when the character has no DPS simulation (supports) or the simulation fails.
 */
export async function simulateMainStatUpgrades(
  character: Character,
  relicsById: Partial<Record<string, Relic>>,
): Promise<SimulatedMainStatUpgrade[] | null> {
  const showcaseState = useShowcaseTabStore.getState()
  const teamSelections = showcaseState.showcaseTeamPreferenceByConfig[character.id] ?? {}
  const temporaryOptions = showcaseState.showcaseTemporaryOptionsByCharacter[character.id] ?? {}

  const { configMetadata } = resolveShowcaseScoringData({ character, teamSelections, storedScoringType: undefined })
  const simulationMetadata = configMetadata[ScoringConfigType.DPS]
  if (!simulationMetadata) return null

  const relics = getPreviewRelics(character, relicsById)
  const config: ScoringConfig = { configType: ScoringConfigType.DPS, simulation: simulationMetadata }
  const cacheKey = computeScoringCacheKey(character, ScoringConfigType.DPS, simulationMetadata, relics, temporaryOptions)
  const score = await requestScoreUpgrades(cacheKey, character, config, relics, temporaryOptions)
  if (!score) return null

  const bestByPart = new Map<MainStatParts, SimulatedMainStatUpgrade>()
  for (const upgrade of score.mainUpgrades) {
    const part = upgrade.part
    const stat = upgrade.stat as StatsValues | undefined
    const current = part ? relics[part]?.main.stat : undefined
    if (!part || !stat || !current || stat === current) continue

    // Same exclusions as the Showcase main stat upgrade table: SPD boots are a speed tuning choice,
    // and ERR ropes are expected from the eidolon that needs them
    if (current === Stats.SPD || stat === Stats.SPD) continue
    const errRopeEidolon = simulationMetadata.errRopeEidolon
    if (current === Stats.ERR && errRopeEidolon != null && character.form.characterEidolon >= errRopeEidolon) continue

    const { damagePercentUpgrade } = sharedSimResultComparator(score, upgrade)
    if (damagePercentUpgrade < MIN_DAMAGE_GAIN_PCT) continue

    const previous = bestByPart.get(part)
    if (!previous || damagePercentUpgrade > previous.damageGainPct) {
      bestByPart.set(part, { part, current, best: stat, damageGainPct: damagePercentUpgrade })
    }
  }

  return [...bestByPart.values()].sort((a, b) => b.damageGainPct - a.damageGainPct)
}
