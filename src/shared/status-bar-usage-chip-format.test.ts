import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STATUS_BAR_USAGE_CHIP_PARTS,
  formatStatusBarUsageChipSample,
  matchStatusBarUsageChipPreset,
  normalizeStatusBarUsageChipParts,
  STATUS_BAR_USAGE_CHIP_PRESETS
} from './status-bar-usage-chip-format'

const SAMPLE = {
  percentage: '42%',
  labelled: '42% used',
  spacedDuration: '3h 54m',
  tightDuration: '3h54m'
}

// Why a second sample: the labelled form is not the bare one plus a fixed word.
// In 'remaining' mode the number is the complement, so a formatter that spliced
// a word onto `percentage` would render "42% left" for a chip the status bar
// draws as "58% left".
const REMAINING_SAMPLE = {
  percentage: '58%',
  labelled: '58% left',
  spacedDuration: '3h 54m',
  tightDuration: '3h54m'
}

describe('normalizeStatusBarUsageChipParts', () => {
  it('defaults to the long-standing labelled chip', () => {
    // Why this matters: an upgrade must not restyle a status bar nobody asked
    // to change, so every default has to reproduce today's rendering.
    expect(normalizeStatusBarUsageChipParts(undefined)).toEqual(DEFAULT_STATUS_BAR_USAGE_CHIP_PARTS)
    expect(formatStatusBarUsageChipSample(DEFAULT_STATUS_BAR_USAGE_CHIP_PARTS, SAMPLE)).toBe(
      '42% used 3h 54m'
    )
    expect(matchStatusBarUsageChipPreset(DEFAULT_STATUS_BAR_USAGE_CHIP_PARTS)).toBe('labelled')
  })

  it('keeps each part independent of the others', () => {
    const parts = normalizeStatusBarUsageChipParts({
      statusBarUsageChipDisplayWord: false,
      statusBarUsageChipTightDuration: 'yes',
      statusBarUsageChipWindowLabel: false
    })
    expect(parts.statusBarUsageChipDisplayWord).toBe(false)
    // Non-boolean falls back to its own default, not to a neighbour's value.
    expect(parts.statusBarUsageChipTightDuration).toBe(false)
    expect(parts.statusBarUsageChipWindowLabel).toBe(false)
  })
})

describe('presets', () => {
  it('render the shapes they advertise', () => {
    const render = (preset: keyof typeof STATUS_BAR_USAGE_CHIP_PRESETS): string =>
      formatStatusBarUsageChipSample(STATUS_BAR_USAGE_CHIP_PRESETS[preset], SAMPLE)
    expect(render('labelled')).toBe('42% used 3h 54m')
    expect(render('compact')).toBe('42%, 3h54m')
    expect(render('percentOnly')).toBe('42%')
  })

  it('round-trip through preset matching', () => {
    for (const preset of Object.keys(
      STATUS_BAR_USAGE_CHIP_PRESETS
    ) as (keyof typeof STATUS_BAR_USAGE_CHIP_PRESETS)[]) {
      expect(matchStatusBarUsageChipPreset(STATUS_BAR_USAGE_CHIP_PRESETS[preset])).toBe(preset)
    }
  })

  it('report a combination outside the presets as custom', () => {
    // Why null rather than snapping to the nearest preset: a user who turned
    // one part off deliberately should not see the page claim a preset that
    // renders something else.
    const custom = {
      statusBarUsageChipDisplayWord: true,
      statusBarUsageChipTightDuration: true,
      statusBarUsageChipWindowLabel: true
    }
    expect(matchStatusBarUsageChipPreset(custom)).toBeNull()
    expect(formatStatusBarUsageChipSample(custom, SAMPLE)).toBe('42% used 3h54m')
  })
})

describe('formatStatusBarUsageChipSample', () => {
  it('drops the countdown and its separator together', () => {
    expect(
      formatStatusBarUsageChipSample(
        {
          statusBarUsageChipDisplayWord: true,
          statusBarUsageChipTightDuration: true,
          statusBarUsageChipWindowLabel: false
        },
        SAMPLE
      )
    ).toBe('42% used')
  })

  it('takes the whole labelled reading, not the bare percentage plus a word', () => {
    expect(
      formatStatusBarUsageChipSample(STATUS_BAR_USAGE_CHIP_PRESETS.labelled, REMAINING_SAMPLE)
    ).toBe('58% left 3h 54m')
    expect(
      formatStatusBarUsageChipSample(STATUS_BAR_USAGE_CHIP_PRESETS.compact, REMAINING_SAMPLE)
    ).toBe('58%, 3h54m')
  })

  it('joins with a comma only when the word is absent', () => {
    expect(
      formatStatusBarUsageChipSample(
        {
          statusBarUsageChipDisplayWord: false,
          statusBarUsageChipTightDuration: false,
          statusBarUsageChipWindowLabel: true
        },
        SAMPLE
      )
    ).toBe('42%, 3h 54m')
  })
})
