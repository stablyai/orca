/**
 * How a status-bar usage chip spells out one window.
 *
 * The individual parts are the stored truth and each can be set on its own, so
 * a user can compose the chip they want rather than picking the closest of a
 * fixed set. The presets below are shortcuts that write a known-good
 * combination; any other combination is simply "custom".
 *
 * Every default reproduces what the status bar has always rendered
 * ("42% used 3h 54m"), so a release never restyles a layout the user did not
 * ask to change.
 */

export type StatusBarUsageChipParts = {
  /** Spell out "used"/"left" instead of leaving it to the tooltip. */
  statusBarUsageChipDisplayWord: boolean
  /** Drop the separator inside a duration: "3h54m" rather than "3h 54m". */
  statusBarUsageChipTightDuration: boolean
  /** Show the window label (countdown or window length) next to the percentage. */
  statusBarUsageChipWindowLabel: boolean
}

export const DEFAULT_STATUS_BAR_USAGE_CHIP_PARTS: StatusBarUsageChipParts = {
  statusBarUsageChipDisplayWord: true,
  statusBarUsageChipTightDuration: false,
  statusBarUsageChipWindowLabel: true
}

function normalizeFlag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Coerces a persisted blob to a complete set of chip parts.
 *
 * Each part falls back to its own default independently, so a profile that
 * stored only some of them keeps the rest at today's rendering instead of
 * inheriting a neighbour's value.
 */
export function normalizeStatusBarUsageChipParts(
  source:
    | {
        statusBarUsageChipDisplayWord?: unknown
        statusBarUsageChipTightDuration?: unknown
        statusBarUsageChipWindowLabel?: unknown
      }
    | null
    | undefined
): StatusBarUsageChipParts {
  return {
    statusBarUsageChipDisplayWord: normalizeFlag(
      source?.statusBarUsageChipDisplayWord,
      DEFAULT_STATUS_BAR_USAGE_CHIP_PARTS.statusBarUsageChipDisplayWord
    ),
    statusBarUsageChipTightDuration: normalizeFlag(
      source?.statusBarUsageChipTightDuration,
      DEFAULT_STATUS_BAR_USAGE_CHIP_PARTS.statusBarUsageChipTightDuration
    ),
    statusBarUsageChipWindowLabel: normalizeFlag(
      source?.statusBarUsageChipWindowLabel,
      DEFAULT_STATUS_BAR_USAGE_CHIP_PARTS.statusBarUsageChipWindowLabel
    )
  }
}

export type StatusBarUsageChipPreset = 'labelled' | 'compact' | 'percentOnly'

/**
 * Named combinations, offered as one-click shortcuts in settings.
 *
 * - `labelled`     "42% used 3h 54m"  — the long-standing format
 * - `compact`      "42%, 3h54m"       — the word moves to the tooltip
 * - `percentOnly`  "42%"              — countdown only in the tooltip
 */
export const STATUS_BAR_USAGE_CHIP_PRESETS: Record<
  StatusBarUsageChipPreset,
  StatusBarUsageChipParts
> = {
  labelled: {
    statusBarUsageChipDisplayWord: true,
    statusBarUsageChipTightDuration: false,
    statusBarUsageChipWindowLabel: true
  },
  compact: {
    statusBarUsageChipDisplayWord: false,
    statusBarUsageChipTightDuration: true,
    statusBarUsageChipWindowLabel: true
  },
  percentOnly: {
    statusBarUsageChipDisplayWord: false,
    statusBarUsageChipTightDuration: false,
    statusBarUsageChipWindowLabel: false
  }
}

/**
 * The preset a combination corresponds to, or null when it matches none.
 *
 * Why null rather than snapping to the nearest: a user who turned one part off
 * deliberately should not have the settings page claim they chose a preset that
 * renders something else.
 */
export function matchStatusBarUsageChipPreset(
  parts: StatusBarUsageChipParts
): StatusBarUsageChipPreset | null {
  for (const [preset, candidate] of Object.entries(STATUS_BAR_USAGE_CHIP_PRESETS)) {
    if (
      candidate.statusBarUsageChipDisplayWord === parts.statusBarUsageChipDisplayWord &&
      candidate.statusBarUsageChipTightDuration === parts.statusBarUsageChipTightDuration &&
      candidate.statusBarUsageChipWindowLabel === parts.statusBarUsageChipWindowLabel
    ) {
      return preset as StatusBarUsageChipPreset
    }
  }
  return null
}

/**
 * Renders the sample a settings row shows next to each choice.
 *
 * Shared by the preset buttons and the live preview so the page cannot promise
 * one shape and the status bar render another.
 */
export function formatStatusBarUsageChipSample(
  parts: StatusBarUsageChipParts,
  sample: {
    /** Bare percentage, e.g. "42%". */
    percentage: string
    /**
     * The same reading with its direction word, e.g. "42% used" or "58% left".
     *
     * Why the whole labelled string rather than the word on its own: the word
     * and the number are chosen together — "left" goes with the complement of
     * the used percentage — and some locales do not put the word last. Passing
     * what `formatUsagePercentageLabel` already produced keeps the preview from
     * inventing a pairing the status bar would never draw.
     */
    labelled: string
    spacedDuration: string
    tightDuration: string
  }
): string {
  const percentage = parts.statusBarUsageChipDisplayWord ? sample.labelled : sample.percentage
  if (!parts.statusBarUsageChipWindowLabel) {
    return percentage
  }
  const duration = parts.statusBarUsageChipTightDuration
    ? sample.tightDuration
    : sample.spacedDuration
  return parts.statusBarUsageChipDisplayWord
    ? `${percentage} ${duration}`
    : `${percentage}, ${duration}`
}
