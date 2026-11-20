import { describe, expect, it } from 'vitest'
import {
  rebuildTerminalWebglRenderersForPanes,
  registerLivePaneManager,
  unregisterLivePaneManager
} from './pane-manager-registry'

// Guards #43465: an atlas-memory rebuild detaches only the named panes and reattaches none in hidden managers.
function fakeManager(visible: boolean, log: string[], name: string) {
  const manager = {
    resetWebglTextureAtlases: () => {},
    isVisibleForAtlasRecovery: () => visible
  }
  registerLivePaneManager(manager, (only) => {
    log.push(`${name}:detach:${only ? [...only].join(',') : 'all'}`)
    return () => log.push(`${name}:reattach`)
  })
  return manager
}

describe('rebuildTerminalWebglRenderersForPanes', () => {
  it('detaches every named pane before reattaching, and only reattaches visible managers', () => {
    const log: string[] = []
    const managers = Array.from({ length: 10 }, (_, i) => fakeManager(i === 0, log, `m${i}`))
    rebuildTerminalWebglRenderersForPanes(new Set(['p1', 'p2']))
    for (const manager of managers) {
      unregisterLivePaneManager(manager)
    }
    expect(log.filter((entry) => entry.endsWith(':reattach'))).toEqual(['m0:reattach'])
    expect(log.findIndex((entry) => entry.endsWith(':reattach'))).toBe(10)
    expect(log.slice(0, 10).every((entry) => entry.endsWith(':detach:p1,p2'))).toBe(true)
  })
})
