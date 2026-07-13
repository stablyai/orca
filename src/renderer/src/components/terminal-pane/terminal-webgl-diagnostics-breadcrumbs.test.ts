import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { recordTerminalWebglDiagnostic } from '../../../../shared/terminal-webgl-diagnostics'
import {
  getTerminalFreezeBreadcrumbs,
  resetTerminalFreezeBreadcrumbsForTesting
} from './terminal-freeze-breadcrumbs'

// Why: lib-layer WebGL code records through the shared sink because it may not
// import the components-layer ring. Importing terminal-freeze-breadcrumbs wires
// that sink to the ring at module load; this pins that the WebGL crumbs land in
// the same one-paste report as delivery/visibility history.
describe('WebGL diagnostics → freeze breadcrumb ring', () => {
  beforeEach(() => {
    resetTerminalFreezeBreadcrumbsForTesting()
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
})
