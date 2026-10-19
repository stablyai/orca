// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { measureUsageRow, pickCollapsedUsageChips } from './status-bar-usage-collapse'

const GAP = 12
const MORE = 20
// Roster order, as the status bar renders it.
const chips = [
  { provider: 'claude', width: 60, urgent: false, percentage: true },
  { provider: 'codex', width: 60, urgent: false, percentage: true },
  { provider: 'gemini', width: 60, urgent: false, percentage: true },
  { provider: 'grok', width: 60, urgent: false, percentage: true },
  { provider: 'cursor', width: 60, urgent: true, percentage: true }
]

describe('pickCollapsedUsageChips', () => {
  it('collapses nothing when the row fits', () => {
    expect(pickCollapsedUsageChips(chips, 0, MORE, GAP)).toEqual([])
    expect(pickCollapsedUsageChips(chips, -40, MORE, GAP)).toEqual([])
  })

  it('drops calm agents from the end of the roster and keeps the urgent one', () => {
    // 10px over: one chip frees 72px, which also pays for the "+N" chip (20 + 12).
    expect(pickCollapsedUsageChips(chips, 10, MORE, GAP)).toEqual(['grok'])
    expect(pickCollapsedUsageChips(chips, 60, MORE, GAP)).toEqual(['grok', 'gemini'])
  })

  it('reserves room for the "+N" chip it introduces', () => {
    // 41px over + 32px for "+N" = 73px, one more than a single chip frees.
    expect(pickCollapsedUsageChips(chips, 41, MORE, GAP)).toEqual(['grok', 'gemini'])
  })

  it('drops urgent agents only after every calm one', () => {
    expect(pickCollapsedUsageChips(chips, 300, MORE, GAP)).toEqual([
      'grok',
      'gemini',
      'codex',
      'claude',
      'cursor'
    ])
  })

  it('drops urgent agents from the end of the roster too', () => {
    const allUrgent = chips.map((chip) => ({ ...chip, urgent: true }))
    expect(pickCollapsedUsageChips(allUrgent, 10, MORE, GAP)).toEqual(['cursor'])
  })

  it('keeps a provider visible when hiding the last percentage also frees the unit label', () => {
    const mixed = [
      { provider: 'claude', width: 60, urgent: true, percentage: false },
      { provider: 'codex', width: 60, urgent: false, percentage: true }
    ]
    expect(pickCollapsedUsageChips(mixed, 60, MORE, GAP, 30)).toEqual(['codex'])
  })

  it('reserves the unit label while any percentage stays visible', () => {
    expect(pickCollapsedUsageChips(chips, 60, MORE, GAP, 30)).toEqual(['grok', 'gemini'])
  })
})

describe('measureUsageRow unit label', () => {
  const UNIT = 30
  const CHIP = 60

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  // Collapsed items are out of the flow, so the row is narrower by their width and gap.
  function renderRow(options: {
    unitCollapsed: boolean
    moreInRow: boolean
    chips: { provider: string; urgent: boolean; percentage: boolean; collapsed: boolean }[]
  }): HTMLElement {
    const usage = document.createElement('div')
    const row = document.createElement('div')
    row.style.columnGap = `${GAP}px`
    usage.append(row)
    document.body.append(usage)
    const unit = document.createElement('span')
    unit.dataset.usageUnit = ''
    unit.dataset.usageCollapsed = String(options.unitCollapsed)
    row.append(unit)
    const more = document.createElement('span')
    more.dataset.usageMore = ''
    more.dataset.usageCollapsed = String(!options.moreInRow)
    const widths = new Map<Element, number>([
      [unit, UNIT],
      [more, MORE]
    ])
    for (const chip of options.chips) {
      const element = document.createElement('span')
      element.dataset.usageChip = chip.provider
      element.dataset.usageUrgent = String(chip.urgent)
      element.dataset.usagePercentage = String(chip.percentage)
      element.dataset.usageCollapsed = String(chip.collapsed)
      row.append(element)
      widths.set(element, CHIP)
    }
    row.append(more)
    const inRow = [...widths]
      .filter(([element]) => element.getAttribute('data-usage-collapsed') !== 'true')
      .map(([, width]) => width)
    widths.set(
      usage,
      inRow.reduce((sum, width) => sum + width, 0) + Math.max(0, inRow.length - 1) * GAP
    )
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element
    ) {
      return new DOMRect(0, 0, widths.get(this) ?? 0, 16)
    })
    return usage
  }

  it('keeps the natural width when the label collapses with its chips', () => {
    const chips = [
      { provider: 'codex', urgent: false, percentage: true, collapsed: false },
      { provider: 'gemini', urgent: false, percentage: true, collapsed: false }
    ]
    const shown = measureUsageRow(renderRow({ unitCollapsed: false, moreInRow: false, chips }))
    const collapsed = measureUsageRow(
      renderRow({
        unitCollapsed: true,
        moreInRow: true,
        chips: chips.map((chip) => ({ ...chip, collapsed: true }))
      })
    )
    expect(collapsed.renderedWidth).toBe(MORE)
    expect(collapsed.naturalWidth).toBe(shown.naturalWidth)
    expect(shown.chips.map((chip) => chip.percentage)).toEqual([true, true])
  })

  it('drops the label from the pinned width unless an urgent chip shows a percentage', () => {
    const calm = [
      { provider: 'codex', urgent: false, percentage: true, collapsed: false },
      { provider: 'gemini', urgent: true, percentage: false, collapsed: false }
    ]
    const withoutUrgentPercentage = measureUsageRow(
      renderRow({ unitCollapsed: false, moreInRow: false, chips: calm })
    )
    // Natural minus the calm chip and the label, plus the "+N" chip that replaces it.
    expect(withoutUrgentPercentage.pinnedWidth).toBe(
      withoutUrgentPercentage.naturalWidth - (CHIP + GAP) - (UNIT + GAP) + (MORE + GAP)
    )
    const urgent = calm.map((chip) => ({ ...chip, percentage: true }))
    const withUrgentPercentage = measureUsageRow(
      renderRow({ unitCollapsed: false, moreInRow: false, chips: urgent })
    )
    expect(withUrgentPercentage.pinnedWidth).toBe(
      withUrgentPercentage.naturalWidth - (CHIP + GAP) + (MORE + GAP)
    )
  })
})
