import { describe, expect, it } from 'vitest'

import type { ManagedPane, ManagedPaneInternal } from './pane-manager-types'
import { toPublicPane } from './pane-public-view'
import { canApplyPaneMetricOptions, canMeasurePaneForFit } from './pane-fit-measurability'
import {
  applyOrDeferPaneMetricOptions,
  flushDeferredPaneMetricOptions,
  hasDeferredPaneMetricOptions,
  overridePendingPaneMetricOptions,
  paneMetricOptionsAlreadySettled
} from './pane-metric-options-deferral'

function makePane(): ManagedPane {
  return { id: 1, terminal: { options: {} } } as unknown as ManagedPane
}

// getPanes returns new public wrappers each call; deferral must not use pane-object identity.
function makeInternalPane(): ManagedPaneInternal {
  return { id: 1, terminal: { options: {} } } as unknown as ManagedPaneInternal
}

describe('pane-metric-options-deferral', () => {
  it('keeps only the latest deferral and clears it when a measurable apply lands', () => {
    const pane = makePane()

    applyOrDeferPaneMetricOptions(pane, { fontSize: 15 }, false)
    applyOrDeferPaneMetricOptions(pane, { fontSize: 21 }, false)
    applyOrDeferPaneMetricOptions(pane, { fontSize: 18 }, true)

    expect(pane.terminal.options.fontSize).toBe(18)
    expect(flushDeferredPaneMetricOptions(pane)).toBe(false)
    expect(pane.terminal.options.fontSize).toBe(18)
  })

  it('flushes through a different pane view than the one that deferred', () => {
    const internal = makeInternalPane()
    const deferView = toPublicPane(internal)
    const flushView = toPublicPane(internal)
    // Fresh wrappers represent the same terminal, matching repeated getPanes calls.
    expect(deferView).not.toBe(flushView)

    applyOrDeferPaneMetricOptions(deferView, { fontSize: 16 }, false)

    expect(hasDeferredPaneMetricOptions(flushView)).toBe(true)
    expect(flushDeferredPaneMetricOptions(flushView)).toBe(true)
    expect(internal.terminal.options.fontSize).toBe(16)
  })

  it('reports settled only when every value is live and nothing is parked', () => {
    const pane = makePane()
    applyOrDeferPaneMetricOptions(pane, { fontSize: 14, lineHeight: 1.2 }, true)

    expect(paneMetricOptionsAlreadySettled(pane, { fontSize: 14, lineHeight: 1.2 })).toBe(true)
    expect(paneMetricOptionsAlreadySettled(pane, { fontSize: 15, lineHeight: 1.2 })).toBe(false)
  })

  it('is never settled while a deferral is parked, even if values match', () => {
    // Even an equal-valued apply must clear stale deferred values.
    const pane = makePane()
    applyOrDeferPaneMetricOptions(pane, { fontSize: 20 }, false)
    pane.terminal.options.fontSize = 14

    expect(paneMetricOptionsAlreadySettled(pane, { fontSize: 14 })).toBe(false)
  })

  it('folds a direct write into a pending deferral so the flush cannot clobber it', () => {
    const pane = makePane()
    applyOrDeferPaneMetricOptions(pane, { fontSize: 12, lineHeight: 1.5 }, false)

    // Font zoom writes directly before fit flushes deferred values.
    pane.terminal.options.fontSize = 22
    overridePendingPaneMetricOptions(pane, { fontSize: 22 })
    flushDeferredPaneMetricOptions(pane)

    expect(pane.terminal.options.fontSize).toBe(22)
    expect(pane.terminal.options.lineHeight).toBe(1.5)
  })
})

describe('canApplyPaneMetricOptions gating', () => {
  function makeSizedPane(rect: { width: number; height: number }, cols: number): ManagedPane {
    return {
      id: 2,
      terminal: { options: {} },
      container: { getBoundingClientRect: () => rect },
      fitAddon: { proposeDimensions: () => ({ cols, rows: 20 }) }
    } as unknown as ManagedPane
  }

  it('applies to a pane clamped narrow by a divider drag', () => {
    // The 50px divider clamp clears the pixel floor but not the grid floor; using the latter would strand fonts indefinitely.
    expect(canApplyPaneMetricOptions(makeSizedPane({ width: 50, height: 600 }, 5))).toBe(true)
  })

  it('still defers on a near-zero box (hidden pane / worktree-switch overlay)', () => {
    expect(canApplyPaneMetricOptions(makeSizedPane({ width: 0, height: 0 }, 0))).toBe(false)
  })

  it('leaves the cols/rows floor on the fit itself', () => {
    expect(canMeasurePaneForFit(makeSizedPane({ width: 50, height: 600 }, 5))).toBe(false)
  })
})
