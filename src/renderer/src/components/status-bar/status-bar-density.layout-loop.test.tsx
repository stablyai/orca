// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStatusBarDensity } from './status-bar-density'

const PROVIDERS = ['claude', 'codex', 'gemini', 'grok', 'kimi']
const CHIP_GAP = 12
const MORE_CHIP = 20

const layout = {
  barWidth: 0,
  collapsedChipDrift: (_collapsedCount: number) => 0
}

function chipWidth(element: HTMLElement): number {
  const base = element.closest('[data-compact="true"]') ? 40 : 70
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
    return element.dataset.iconOnly === 'true' ? 30 : 80
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
  return (
    <div
      ref={barRef}
      data-bar
      style={{ columnGap: '16px', paddingLeft: '0px', paddingRight: '0px' }}
    >
      <div ref={usageRef} data-usage data-compact={density.compact}>
        <span style={{ columnGap: `${CHIP_GAP}px` }}>
          {PROVIDERS.map((provider) => (
            <span
              key={provider}
              data-usage-chip={provider}
              data-usage-urgent="false"
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

  beforeEach(() => {
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

  it('settles when collapsed chips measure a few pixels off their in-row width', () => {
    // A collapsed (out-of-flow) chip measuring 2px off its in-row width restarted probing from level 0 forever.
    layout.barWidth = 220
    layout.collapsedChipDrift = () => 2
    expect(() => act(() => root.render(<Harness />))).not.toThrow()
    expect(container.querySelectorAll('[data-usage-collapsed="true"]').length).toBeGreaterThan(0)
  })

  it('stops re-collapsing when each collapse makes the next one measure differently', () => {
    layout.barWidth = 220
    layout.collapsedChipDrift = (collapsedCount) => (collapsedCount >= 3 ? -60 : 0)
    expect(() => act(() => root.render(<Harness />))).not.toThrow()
  })
})
