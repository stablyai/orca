import { describe, expect, it, vi } from 'vitest'
import { setTerminalWebglDiagnosticRecorder } from '../../../../shared/terminal-webgl-diagnostics'
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

// Mirrors PaneManager.getPanes(), which returns a fresh toPublicPane() wrapper
// per call — so deferral state must not be keyed on the pane object identity.
function makeInternalPane(): ManagedPaneInternal {
  return { id: 1, terminal: { options: {} } } as unknown as ManagedPaneInternal
}

describe('pane-metric-options-deferral', () => {
  it('writes metric options directly when the pane is measurable', () => {
    const pane = makePane()

    const result = applyOrDeferPaneMetricOptions(pane, { fontSize: 16, fontFamily: 'X' }, true)

    expect(result).toBe('applied')
    expect(pane.terminal.options.fontSize).toBe(16)
    expect(pane.terminal.options.fontFamily).toBe('X')
    expect(hasDeferredPaneMetricOptions(pane)).toBe(false)
  })

  it('defers writes on an unmeasurable pane until flushed', () => {
    const pane = makePane()

    const result = applyOrDeferPaneMetricOptions(pane, { fontSize: 16 }, false)

    expect(result).toBe('deferred')
    expect(pane.terminal.options.fontSize).toBeUndefined()
    expect(hasDeferredPaneMetricOptions(pane)).toBe(true)

    expect(flushDeferredPaneMetricOptions(pane)).toBe(true)
    expect(pane.terminal.options.fontSize).toBe(16)
    expect(hasDeferredPaneMetricOptions(pane)).toBe(false)
  })

  it('keeps only the latest deferral and clears it when a measurable apply lands', () => {
    const pane = makePane()

    applyOrDeferPaneMetricOptions(pane, { fontSize: 15 }, false)
    applyOrDeferPaneMetricOptions(pane, { fontSize: 21 }, false)
    // A later measurable apply supersedes the pending deferral entirely: flushing
    // afterwards must not resurrect the hidden-era value.
    applyOrDeferPaneMetricOptions(pane, { fontSize: 18 }, true)

    expect(pane.terminal.options.fontSize).toBe(18)
    expect(flushDeferredPaneMetricOptions(pane)).toBe(false)
    expect(pane.terminal.options.fontSize).toBe(18)
  })

  it('writes only the provided keys', () => {
    const pane = makePane()
    pane.terminal.options.lineHeight = 1.4

    applyOrDeferPaneMetricOptions(pane, { fontSize: 12 }, true)

    expect(pane.terminal.options.lineHeight).toBe(1.4)
    expect(pane.terminal.options.fontWeight).toBeUndefined()
  })

  it('flush is a no-op without a pending deferral', () => {
    const pane = makePane()
    expect(flushDeferredPaneMetricOptions(pane)).toBe(false)
  })

  it('flushes through a different pane view than the one that deferred', () => {
    const internal = makeInternalPane()
    const deferView = toPublicPane(internal)
    const flushView = toPublicPane(internal)
    // Every getPanes() call allocates a new wrapper; the two views are the same
    // pane but never the same object.
    expect(deferView).not.toBe(flushView)

    applyOrDeferPaneMetricOptions(deferView, { fontSize: 16 }, false)

    expect(hasDeferredPaneMetricOptions(flushView)).toBe(true)
    expect(flushDeferredPaneMetricOptions(flushView)).toBe(true)
    expect(internal.terminal.options.fontSize).toBe(16)
  })

  it('flushes through the internal pane when a public view deferred', () => {
    // fitAllPanesInternal / fitAllRevealedPanes iterate the internal panes.
    const internal = makeInternalPane()

    applyOrDeferPaneMetricOptions(toPublicPane(internal), { fontSize: 17 }, false)

    expect(flushDeferredPaneMetricOptions(internal)).toBe(true)
    expect(internal.terminal.options.fontSize).toBe(17)
  })

  it('reports settled only when every value is live and nothing is parked', () => {
    const pane = makePane()
    applyOrDeferPaneMetricOptions(pane, { fontSize: 14, lineHeight: 1.2 }, true)

    expect(paneMetricOptionsAlreadySettled(pane, { fontSize: 14, lineHeight: 1.2 })).toBe(true)
    expect(paneMetricOptionsAlreadySettled(pane, { fontSize: 15, lineHeight: 1.2 })).toBe(false)
  })

  it('is never settled while a deferral is parked, even if values match', () => {
    // Otherwise an equal-valued apply would skip and strand the stale deferral.
    const pane = makePane()
    applyOrDeferPaneMetricOptions(pane, { fontSize: 20 }, false)
    pane.terminal.options.fontSize = 14

    expect(paneMetricOptionsAlreadySettled(pane, { fontSize: 14 })).toBe(false)
  })

  it('folds a direct write into a pending deferral so the flush cannot clobber it', () => {
    const pane = makePane()
    applyOrDeferPaneMetricOptions(pane, { fontSize: 12, lineHeight: 1.5 }, false)

    // Font zoom writes fontSize directly, then fits — which flushes.
    pane.terminal.options.fontSize = 22
    overridePendingPaneMetricOptions(pane, { fontSize: 22 })
    flushDeferredPaneMetricOptions(pane)

    expect(pane.terminal.options.fontSize).toBe(22)
    // The other parked key still lands.
    expect(pane.terminal.options.lineHeight).toBe(1.5)
  })

  it('override is a no-op when nothing is parked', () => {
    const pane = makePane()
    overridePendingPaneMetricOptions(pane, { fontSize: 22 })

    expect(hasDeferredPaneMetricOptions(pane)).toBe(false)
    expect(pane.terminal.options.fontSize).toBeUndefined()
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
    // 50px is the divider clamp: over the pixel floor but ~5 cols, under the
    // fit floor. Gating on the fit floor would strand it on a stale font,
    // because it never hides and its box never changes.
    expect(canApplyPaneMetricOptions(makeSizedPane({ width: 50, height: 600 }, 5))).toBe(true)
  })

  it('still defers on a near-zero box (hidden pane / worktree-switch overlay)', () => {
    expect(canApplyPaneMetricOptions(makeSizedPane({ width: 0, height: 0 }, 0))).toBe(false)
  })

  it('leaves the cols/rows floor on the fit itself', () => {
    expect(canMeasurePaneForFit(makeSizedPane({ width: 50, height: 600 }, 5))).toBe(false)
  })
})

describe('metric weight-change forensics', () => {
  // Field probe for the bold-collapse bug (STA-4042 family): weights never
  // change in normal operation, so a transition crumb is either the poisoning
  // or the healing write. These fail if the crumb is removed.
  it('records prev/next/reason when a weight value actually changes', () => {
    const recorder = vi.fn()
    setTerminalWebglDiagnosticRecorder(recorder)
    const pane = makePane()
    pane.terminal.options.fontWeight = 500

    applyOrDeferPaneMetricOptions(pane, { fontWeight: 700, fontWeightBold: 700 }, true)

    expect(recorder).toHaveBeenCalledWith('metric-weight-change', {
      paneId: 1,
      key: 'fontWeight',
      prev: '500',
      next: '700',
      reason: 'appearance'
    })
    expect(recorder).toHaveBeenCalledWith('metric-weight-change', {
      paneId: 1,
      key: 'fontWeightBold',
      prev: null,
      next: '700',
      reason: 'appearance'
    })
    setTerminalWebglDiagnosticRecorder(null)
  })

  it('stays silent when the written weights equal the live values', () => {
    const recorder = vi.fn()
    setTerminalWebglDiagnosticRecorder(recorder)
    const pane = makePane()
    pane.terminal.options.fontWeight = 500
    pane.terminal.options.fontWeightBold = 700

    applyOrDeferPaneMetricOptions(
      pane,
      { fontWeight: 500, fontWeightBold: 700, fontSize: 15 },
      true
    )

    expect(recorder).not.toHaveBeenCalledWith('metric-weight-change', expect.anything())
    setTerminalWebglDiagnosticRecorder(null)
  })

  it('labels a flushed deferral as the deferred-flush writer', () => {
    const recorder = vi.fn()
    setTerminalWebglDiagnosticRecorder(recorder)
    const pane = makePane()
    pane.terminal.options.fontWeight = 700

    applyOrDeferPaneMetricOptions(pane, { fontWeight: 500 }, false)
    expect(recorder).not.toHaveBeenCalledWith('metric-weight-change', expect.anything())
    flushDeferredPaneMetricOptions(pane)

    expect(recorder).toHaveBeenCalledWith(
      'metric-weight-change',
      expect.objectContaining({
        key: 'fontWeight',
        prev: '700',
        next: '500',
        reason: 'deferred-flush'
      })
    )
    setTerminalWebglDiagnosticRecorder(null)
  })
})
