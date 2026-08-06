import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recordRendererCrashBreadcrumb } from '@/lib/crash-breadcrumb-recorder'
import { recordTerminalWebglDiagnostic } from '../../../../shared/terminal-webgl-diagnostics'
import {
  getTerminalFreezeBreadcrumbs,
  resetTerminalFreezeBreadcrumbsForTesting
} from './terminal-freeze-breadcrumbs'

vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: vi.fn()
}))

// Why: lib-layer WebGL code records through the shared sink because it may not
// import the components-layer ring. Importing terminal-freeze-breadcrumbs wires
// that sink to the ring at module load; this pins that the WebGL crumbs land in
// the same one-paste report as delivery/visibility history.
describe('WebGL diagnostics → freeze breadcrumb ring', () => {
  beforeEach(() => {
    resetTerminalFreezeBreadcrumbsForTesting()
    vi.mocked(recordRendererCrashBreadcrumb).mockClear()
  })

  afterEach(() => {
    resetTerminalFreezeBreadcrumbsForTesting()
  })

  it('routes context-loss and atlas-reset crumbs into the freeze report ring', () => {
    recordTerminalWebglDiagnostic('webgl-context-loss', { paneId: 3 })
    recordTerminalWebglDiagnostic('webgl-atlas-reset', { managers: 1 })

    const crumbs = getTerminalFreezeBreadcrumbs()
    expect(crumbs.map((crumb) => crumb.kind)).toEqual(['webgl-context-loss', 'webgl-atlas-reset'])
    expect(crumbs[0]?.detail).toEqual({ paneId: 3 })
    expect(crumbs[1]?.detail).toEqual({ managers: 1 })
  })

  // Why: the freeze ring is DevTools-only (window.n()), so a renderer that dies
  // takes its WebGL history with it. Windows crash F0BKR84AHEH had three GPU
  // deaths in the 65s before its renderer OOM and zero WebGL evidence.
  it('mirrors WebGL crumbs into the crash report so a dead renderer still reports them', () => {
    recordTerminalWebglDiagnostic('webgl-context-loss', { paneId: 3 })

    expect(recordRendererCrashBreadcrumb).toHaveBeenCalledWith('terminal_webgl_diagnostic', {
      kind: 'webgl-context-loss',
      paneId: 3
    })
  })

  it('mirrors detail-less crumbs without inventing fields', () => {
    recordTerminalWebglDiagnostic('webgl-context-restore')

    expect(recordRendererCrashBreadcrumb).toHaveBeenCalledWith('terminal_webgl_diagnostic', {
      kind: 'webgl-context-restore'
    })
  })
})
