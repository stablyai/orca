// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STATUS_BAR_DENSITY_LEVELS, useStatusBarDensity } from './status-bar-density'

// Layout model: 5 calm chips (70px roomy, 40px compact), 12px gaps, a 20px "+N" chip,
// segments 80px (30px icon-only), 16px bar gap. Level 3 at 220px collapses gemini, grok, kimi:
// claude + codex + "+N" = 40 + 40 + 20 + 2 * 12 = 124, plus 16 + 80 = 220.
const PROVIDERS = ['claude', 'codex', 'gemini', 'grok', 'kimi']
const CHIP_GAP = 12
const MORE_CHIP = 20
const TIGHTEST = STATUS_BAR_DENSITY_LEVELS.length - 1

const layout = {
  barWidth: 0,
  chipWidth: (compact: boolean): number => (compact ? 40 : 70),
  /** Extra width a collapsed (out-of-flow) chip measures compared with its in-row width. */
  collapsedChipDrift: (_collapsedCount: number) => 0,
  segmentsWidth: (iconOnly: boolean): number => (iconOnly ? 30 : 80),
  urgent: new Set<string>()
}
let harnessRenders = 0

function resetLayout(): void {
  layout.chipWidth = (compact) => (compact ? 40 : 70)
  layout.collapsedChipDrift = () => 0
  layout.segmentsWidth = (iconOnly) => (iconOnly ? 30 : 80)
  layout.urgent = new Set()
  harnessRenders = 0
}

function chipWidth(element: HTMLElement): number {
  const base = layout.chipWidth(element.closest('[data-compact="true"]') !== null)
  if (element.dataset.usageCollapsed !== 'true') {
    return base
  }
  const collapsedCount = element.parentElement?.querySelectorAll(
    '[data-usage-chip][data-usage-collapsed="true"]'
  ).length
  return base + layout.collapsedChipDrift(collapsedCount ?? 0)
}

function measure(element: HTMLElement): number {
  if (element.dataset.usageChip !== undefined) {
    return chipWidth(element)
  }
  if (element.dataset.usageMore !== undefined) {
    return MORE_CHIP
  }
  if (element.dataset.segments !== undefined) {
    return layout.segmentsWidth(element.dataset.iconOnly === 'true')
  }
  if (element.dataset.usage !== undefined) {
    const row = [...element.querySelectorAll<HTMLElement>('[data-usage-chip],[data-usage-more]')]
    const inRow = row.filter((child) => child.dataset.usageCollapsed !== 'true')
    return inRow.reduce((sum, child) => sum + measure(child), 0) + CHIP_GAP * (inRow.length - 1)
  }
  return 0
}

function Harness(): React.JSX.Element {
  const { density, collapsedUsageProviders, barRef, usageRef, segmentsRef } = useStatusBarDensity()
  harnessRenders += 1
  return (
    <div
      ref={barRef}
      data-bar
      data-level={STATUS_BAR_DENSITY_LEVELS.indexOf(density)}
      style={{ columnGap: '16px', paddingLeft: '0px', paddingRight: '0px' }}
    >
      <div ref={usageRef} data-usage data-compact={density.compact}>
        <span style={{ columnGap: `${CHIP_GAP}px` }}>
          {PROVIDERS.map((provider) => (
            <span
              key={provider}
              data-usage-chip={provider}
              data-usage-urgent={layout.urgent.has(provider)}
              data-usage-percentage="false"
              data-usage-collapsed={collapsedUsageProviders.includes(provider)}
            />
          ))}
          {density.collapseUsage ? (
            <span data-usage-more data-usage-collapsed={collapsedUsageProviders.length === 0} />
          ) : null}
        </span>
      </div>
      <div ref={segmentsRef} data-segments data-icon-only={density.segmentsIconOnly} />
    </div>
  )
}

describe('useStatusBarDensity layout settling', () => {
  let container: HTMLDivElement
  let root: Root

  const settledLevel = (): number =>
    Number(container.querySelector<HTMLElement>('[data-bar]')!.dataset.level)
  const collapsed = (): string[] =>
    [
      ...container.querySelectorAll<HTMLElement>('[data-usage-chip][data-usage-collapsed="true"]')
    ].map((chip) => chip.dataset.usageChip!)
  const renderedWidth = (): number =>
    measure(container.querySelector<HTMLElement>('[data-usage]')!) +
    16 +
    measure(container.querySelector<HTMLElement>('[data-segments]')!)
  const renderAt = (width: number): void => {
    layout.barWidth = width
    act(() => root.render(<Harness />))
  }

  beforeEach(() => {
    resetLayout()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      }
    )
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      return DOMRect.fromRect({ width: measure(this) })
    })
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
      this: HTMLElement
    ) {
      return this.dataset.bar !== undefined ? layout.barWidth : 0
    })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  describe('without measurement drift', () => {
    it('collapses exactly the chips that need to go on a first render at a narrow width', () => {
      renderAt(220)
      expect(settledLevel()).toBe(3)
      expect(collapsed()).toEqual(['gemini', 'grok', 'kimi'])
      expect(renderedWidth()).toBeLessThanOrEqual(220)
    })

    it('lands on the same state when the bar narrows from wide', () => {
      renderAt(1000)
      expect(settledLevel()).toBe(0)
      expect(collapsed()).toEqual([])
      renderAt(220)
      expect(settledLevel()).toBe(3)
      expect(collapsed()).toEqual(['gemini', 'grok', 'kimi'])
    })
  })

  it('re-picks the collapsed chips when a collapsed chip turns urgent at the same width', () => {
    renderAt(220)
    expect(collapsed()).toEqual(['gemini', 'grok', 'kimi'])
    // Usage polling marks kimi urgent; no width moves, but an urgent chip must not stay folded into "+N".
    layout.urgent = new Set(['kimi'])
    renderAt(220)
    expect(settledLevel()).toBe(3)
    expect(collapsed()).toEqual(['codex', 'gemini', 'grok'])
    expect(renderedWidth()).toBeLessThanOrEqual(220)
  })

  it('settles on the drift-free result when collapsed chips measure a few pixels off', () => {
    // An out-of-flow chip measuring 2px off its in-row width used to restart probing from level 0 forever.
    layout.collapsedChipDrift = () => 2
    renderAt(220)
    expect(settledLevel()).toBe(3)
    expect(collapsed()).toEqual(['gemini', 'grok', 'kimi'])
  })

  it('still re-probes roomier levels when content shrinks in the same render as a collapse', () => {
    let shrunk = false
    layout.chipWidth = (compact) => {
      // The labels get shorter right as the first chips collapse.
      shrunk ||= container.querySelector('[data-usage-chip][data-usage-collapsed="true"]') !== null
      return shrunk ? 10 : compact ? 40 : 70
    }
    renderAt(220)
    expect(shrunk).toBe(true)
    // 5 * 10 + 4 * 12 + 16 + 80 = 194 fits the roomiest level once its stale width is dropped.
    expect(settledLevel()).toBe(0)
    expect(collapsed()).toEqual([])
  })

  it('falls back to the tightest fitting layout when measurements never settle', () => {
    // Synthetic drift: the roomier levels re-measure differently every time, so probing never ends.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let flip = false
    layout.segmentsWidth = (iconOnly) => {
      flip = !flip
      return iconOnly ? 30 : flip ? 80 : 90
    }
    expect(() => renderAt(220)).not.toThrow()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('did not settle'))
    expect(settledLevel()).toBe(TIGHTEST)
    expect(collapsed()).toEqual(PROVIDERS)
    expect(renderedWidth()).toBeLessThanOrEqual(220)
  })

  it('ends in a fitting state when each collapse changes how the other collapsed chips measure', () => {
    // Synthetic worst case: a large drift that depends on how many chips are collapsed defeats the remembered widths.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    layout.collapsedChipDrift = (collapsedCount) => (collapsedCount >= 3 ? -60 : 0)
    expect(() => renderAt(220)).not.toThrow()
    expect(renderedWidth()).toBeLessThanOrEqual(220)
  })

  it('stays in the fallback across outside re-renders until the room or the content changes', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let flip = false
    layout.segmentsWidth = (iconOnly) => {
      flip = !flip
      return iconOnly ? 30 : flip ? 80 : 90
    }
    renderAt(220)
    expect(settledLevel()).toBe(TIGHTEST)

    // Usage polling and agent status re-render the bar; each must cost one commit, not a fresh probe.
    for (let i = 0; i < 5; i++) {
      harnessRenders = 0
      renderAt(220)
      expect(harnessRenders).toBe(1)
      expect(settledLevel()).toBe(TIGHTEST)
    }
    expect(warn).toHaveBeenCalledTimes(1)

    // A chip turning urgent is a content change: the fallback re-runs and keeps the urgent chip visible.
    layout.urgent = new Set(['kimi'])
    renderAt(220)
    expect(collapsed()).toEqual(['claude', 'codex', 'gemini', 'grok'])
    expect(renderedWidth()).toBeLessThanOrEqual(220)
    expect(warn).toHaveBeenCalledTimes(1)

    // More room ends the fallback.
    renderAt(1000)
    expect(settledLevel()).toBe(0)
    expect(collapsed()).toEqual([])
  })
})
