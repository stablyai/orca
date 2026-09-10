import { describe, expect, it } from 'vitest'
import type {
  WorkspaceSurface,
  WorkspaceSurfaceSnapshot
} from '../../../../shared/maestro-workspace-canvas'
import { workspaceSurfaceKey } from '../../../../shared/maestro-workspace-canvas'
import {
  reconcileMaestroWorkspacePresence,
  settleMaestroWorkspacePresence,
  transientMaestroWorkspacePresence,
  type MaestroWorkspacePresenceItem
} from './maestro-workspace-presence'

function terminalSurface(tabId: string, title = tabId): WorkspaceSurface {
  return {
    id: {
      execution_host_id: 'host',
      workspace_key: 'folder:workspace',
      unified_tab_id: tabId
    },
    entity_id: `terminal-${tabId}`,
    group_id: 'group',
    content_type: 'terminal',
    title,
    revision: 1,
    availability: 'available',
    binding: {
      kind: 'terminal',
      terminal_tab_id: `terminal-${tabId}`,
      pane_key: `pane-${tabId}`,
      session_id: `pty-${tabId}`,
      pty_incarnation: `incarnation-${tabId}`,
      liveness: 'live',
      authority_revision: 1
    }
  }
}

function snapshot(surfaces: WorkspaceSurface[]): WorkspaceSurfaceSnapshot {
  return {
    schema_version: 1,
    protocol: 'workspace-surface-snapshot/v1',
    execution_host_id: 'host',
    workspace_key: 'folder:workspace',
    authority_revision: 1,
    authority_cursor: 'cursor-1',
    state: 'ready',
    surfaces: Object.fromEntries(
      surfaces.map((surface) => [workspaceSurfaceKey(surface.id), surface])
    ),
    unsupported: [],
    automatic_links: [],
    suggested_links: [],
    capability: { available: true, reason: null },
    harness_overlay: null
  }
}

describe('reconcileMaestroWorkspacePresence', () => {
  it('marks only newly discovered surfaces as entering', () => {
    const first = terminalSurface('first')
    const second = terminalSurface('second')
    const firstKey = workspaceSurfaceKey(first.id)
    const secondKey = workspaceSurfaceKey(second.id)
    const current: MaestroWorkspacePresenceItem[] = [
      { surfaceKey: firstKey, surface: first, phase: 'present' }
    ]

    expect(
      reconcileMaestroWorkspacePresence(current, snapshot([first, second]), [firstKey, secondKey])
    ).toMatchObject([
      { surfaceKey: firstKey, phase: 'present' },
      { surfaceKey: secondKey, phase: 'entering' }
    ])
  })

  it('retains the last truthful surface while it exits', () => {
    const surface = terminalSurface('first')
    const surfaceKey = workspaceSurfaceKey(surface.id)
    const current: MaestroWorkspacePresenceItem[] = [{ surfaceKey, surface, phase: 'present' }]

    expect(reconcileMaestroWorkspacePresence(current, snapshot([]), [])).toEqual([
      { surfaceKey, surface, phase: 'exiting' }
    ])
  })

  it('preserves sibling order while a surface exits', () => {
    const first = terminalSurface('first')
    const second = terminalSurface('second')
    const third = terminalSurface('third')
    const firstKey = workspaceSurfaceKey(first.id)
    const secondKey = workspaceSurfaceKey(second.id)
    const thirdKey = workspaceSurfaceKey(third.id)
    const current: MaestroWorkspacePresenceItem[] = [
      { surfaceKey: firstKey, surface: first, phase: 'present' },
      { surfaceKey: secondKey, surface: second, phase: 'present' },
      { surfaceKey: thirdKey, surface: third, phase: 'present' }
    ]

    expect(
      reconcileMaestroWorkspacePresence(current, snapshot([first, third]), [firstKey, thirdKey])
    ).toMatchObject([
      { surfaceKey: firstKey, phase: 'present' },
      { surfaceKey: secondKey, phase: 'exiting' },
      { surfaceKey: thirdKey, phase: 'present' }
    ])
  })

  it('restarts entry when authority restores an exiting surface', () => {
    const surface = terminalSurface('first')
    const surfaceKey = workspaceSurfaceKey(surface.id)
    const current: MaestroWorkspacePresenceItem[] = [{ surfaceKey, surface, phase: 'exiting' }]

    expect(reconcileMaestroWorkspacePresence(current, snapshot([surface]), [surfaceKey])).toEqual([
      { surfaceKey, surface, phase: 'entering' }
    ])
  })
})

describe('settleMaestroWorkspacePresence', () => {
  it('settles entry and removes only a matching exit', () => {
    const surface = terminalSurface('first')
    const surfaceKey = workspaceSurfaceKey(surface.id)
    const entering: MaestroWorkspacePresenceItem[] = [{ surfaceKey, surface, phase: 'entering' }]
    expect(settleMaestroWorkspacePresence(entering, surfaceKey, 'entering')[0]?.phase).toBe(
      'present'
    )
    expect(
      settleMaestroWorkspacePresence(
        [{ surfaceKey, surface, phase: 'exiting' }],
        surfaceKey,
        'exiting'
      )
    ).toEqual([])
  })
})

describe('transientMaestroWorkspacePresence', () => {
  it('starts entry only after placement makes the surface renderable', () => {
    const surface = terminalSurface('external')
    const surfaceKey = workspaceSurfaceKey(surface.id)
    const entering: MaestroWorkspacePresenceItem[] = [{ surfaceKey, surface, phase: 'entering' }]

    expect(transientMaestroWorkspacePresence(entering, new Set())).toEqual(new Map())
    expect(transientMaestroWorkspacePresence(entering, new Set([surfaceKey]))).toEqual(
      new Map([[surfaceKey, 'entering']])
    )
  })

  it('settles exits even after their live placement disappears', () => {
    const surface = terminalSurface('external')
    const surfaceKey = workspaceSurfaceKey(surface.id)

    expect(
      transientMaestroWorkspacePresence([{ surfaceKey, surface, phase: 'exiting' }], new Set())
    ).toEqual(new Map([[surfaceKey, 'exiting']]))
  })
})
