import {
  DEFAULT_STATUS_BAR_USAGE_BARS_VISIBLE,
  normalizeStatusBarUsageBarsVisible
} from './status-bar-usage-bars'
import {
  DEFAULT_STATUS_BAR_USAGE_CHIP_PARTS,
  normalizeStatusBarUsageChipParts,
  type StatusBarUsageChipParts
} from './status-bar-usage-chip-format'
import {
  DEFAULT_STATUS_BAR_USAGE_MODE,
  normalizeStatusBarUsageMode,
  type StatusBarUsageMode
} from './status-bar-usage-mode'

export type StatusBarUsagePreferences = {
  statusBarUsageMode: StatusBarUsageMode
  statusBarUsageBarsVisible: boolean
} & StatusBarUsageChipParts

/**
 * Normalizes the pair of status-bar usage presentation preferences together.
 *
 * Why as a group: density, bar visibility and chip format are always read from
 * the same persisted blob and written into the same store slice, and they
 * qualify each other — the bar preference only applies to the verbose density.
 * Normalizing them in one place keeps a reader from finding one applied and
 * another forgotten at a call site.
 */
export function normalizeStatusBarUsagePreferences(
  source:
    | {
        statusBarUsageMode?: unknown
        statusBarUsageBarsVisible?: unknown
        statusBarUsageChipDisplayWord?: unknown
        statusBarUsageChipTightDuration?: unknown
        statusBarUsageChipWindowLabel?: unknown
      }
    | null
    | undefined
): StatusBarUsagePreferences {
  return {
    statusBarUsageMode: normalizeStatusBarUsageMode(source?.statusBarUsageMode),
    statusBarUsageBarsVisible: normalizeStatusBarUsageBarsVisible(
      source?.statusBarUsageBarsVisible
    ),
    ...normalizeStatusBarUsageChipParts(source)
  }
}

/**
 * Seed values for the persisted UI state.
 *
 * Why both live here: DEFAULT_UI_STATE is what a fresh profile starts from and
 * what applyUIStateUpdate merges over, so leaving one of the pair out would let
 * a new install disagree with an upgraded one about the same layout. Keeping
 * them adjacent is also what stops the next preference in this group from being
 * added to one list and forgotten in the other.
 */
export const DEFAULT_STATUS_BAR_USAGE_PREFERENCES: StatusBarUsagePreferences = {
  statusBarUsageMode: DEFAULT_STATUS_BAR_USAGE_MODE,
  statusBarUsageBarsVisible: DEFAULT_STATUS_BAR_USAGE_BARS_VISIBLE,
  ...DEFAULT_STATUS_BAR_USAGE_CHIP_PARTS
}

/**
 * Applies a partial update over the persisted values.
 *
 * Why this lives here rather than being spelled out at the call site: main
 * normalizes a fixed field list, so a preference the caller forgets is not
 * merely un-normalized — it never persists and never comes back. Keeping the
 * merge beside the shape means a new part is added in one place.
 */
export function mergeStatusBarUsagePreferences(
  existing: Parameters<typeof normalizeStatusBarUsagePreferences>[0],
  updates: Parameters<typeof normalizeStatusBarUsagePreferences>[0]
): StatusBarUsagePreferences {
  return normalizeStatusBarUsagePreferences({
    statusBarUsageMode: updates?.statusBarUsageMode ?? existing?.statusBarUsageMode,
    statusBarUsageBarsVisible:
      updates?.statusBarUsageBarsVisible ?? existing?.statusBarUsageBarsVisible,
    statusBarUsageChipDisplayWord:
      updates?.statusBarUsageChipDisplayWord ?? existing?.statusBarUsageChipDisplayWord,
    statusBarUsageChipTightDuration:
      updates?.statusBarUsageChipTightDuration ?? existing?.statusBarUsageChipTightDuration,
    statusBarUsageChipWindowLabel:
      updates?.statusBarUsageChipWindowLabel ?? existing?.statusBarUsageChipWindowLabel
  })
}
