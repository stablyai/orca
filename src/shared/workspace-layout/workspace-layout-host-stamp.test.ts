// A cross-host terminal's stamp through the layout Loader and Serializer, which every main-side
// writer of a window-owned partition rewrites it with. The stamp must come back as stored.

import { describe, expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../execution-host'
import type { Tab } from '../tab-types'
import type { WorkspaceSessionState } from '../workspace-session-state-types'
import { applyLayoutCommand } from './workspace-layout-commands'
import { loadWorkspaceLayout } from './workspace-layout-load'
import { nameBasedLoadContext } from './workspace-layout-minted-ids'
import { publishWorkspaceLayout } from './workspace-layout-published'
import { checkLayoutRoundTrip } from './workspace-layout-round-trip-check'
import { saveWorkspaceLayout } from './workspace-layout-save'
import { addWorkspace, emptySession, GIT_KEY, leaf } from './workspace-layout-session.test-fixture'

const onDisk = (session: WorkspaceSessionState): WorkspaceSessionState =>
  JSON.parse(JSON.stringify(session))

function stampedSession(stamp: Partial<Tab>): WorkspaceSessionState {
  return onDisk(
    addWorkspace(emptySession(), GIT_KEY, [
      {
        id: 'g1',
        tabs: [
          { id: 'tab-local', leaves: [[leaf(1), 'pty-local']] },
          {
            id: 'tab-host',
            leaves: [
              [leaf(2), 'remote:env-a@@h1'],
              [leaf(3), 'remote:env-a@@h2']
            ],
            entry: stamp
          }
        ]
      }
    ])
  )
}

function roundTrip(session: WorkspaceSessionState): WorkspaceSessionState {
  return onDisk(
    saveWorkspaceLayout(
      loadWorkspaceLayout(LOCAL_EXECUTION_HOST_ID, session, nameBasedLoadContext())
    )
  )
}

const entryOf = (session: WorkspaceSessionState, id: string) =>
  session.unifiedTabs?.[GIT_KEY]?.find((entry) => entry.id === id)

const STAMPS: [string, Partial<Tab>][] = [
  ['a valid stamp', { executionHostId: 'runtime:env-a', projectHostSetupId: 'setup-a' }],
  ['a numeric setup', { executionHostId: 'runtime:env-a', projectHostSetupId: 42 }],
  ['a null setup', { executionHostId: 'runtime:env-a', projectHostSetupId: null }],
  ['a blank setup', { executionHostId: 'runtime:env-a', projectHostSetupId: '' }],
  ['a local host', { executionHostId: LOCAL_EXECUTION_HOST_ID, projectHostSetupId: 'setup-a' }],
  ['no host at all', { executionHostId: undefined, projectHostSetupId: 'setup-a' }]
]

describe('layout Loader and Serializer: a cross-host terminal stamp', () => {
  it.each(STAMPS)('writes %s back exactly as stored, and changes nothing else', (_label, stamp) => {
    const stored = stampedSession(stamp)
    expect(checkLayoutRoundTrip(LOCAL_EXECUTION_HOST_ID, stored).findings).toEqual([])
    const loaded = loadWorkspaceLayout(LOCAL_EXECUTION_HOST_ID, stored, nameBasedLoadContext())
    expect(loaded.changes).toEqual([])
    const saved = roundTrip(stored)
    expect(entryOf(saved, 'tab-host')).toEqual(entryOf(stored, 'tab-host'))
    expect(entryOf(saved, 'tab-local')?.executionHostId).toBe(LOCAL_EXECUTION_HOST_ID)
    expect(entryOf(saved, 'tab-local')).not.toHaveProperty('projectHostSetupId')
    expect(roundTrip(saved)).toEqual(saved)
  })

  it('still names the partition host for an unstamped entry that names another host', () => {
    const stored = stampedSession({ executionHostId: 'runtime:env-a' })
    const saved = roundTrip(stored)
    expect(entryOf(saved, 'tab-host')?.executionHostId).toBe(LOCAL_EXECUTION_HOST_ID)
    expect(entryOf(saved, 'tab-host')).not.toHaveProperty('projectHostSetupId')
  })

  it('keeps the stamp on a pane split off a stamped tab into its own tab', () => {
    const stored = stampedSession({ executionHostId: 'runtime:env-a', projectHostSetupId: 42 })
    const loaded = loadWorkspaceLayout(LOCAL_EXECUTION_HOST_ID, stored, nameBasedLoadContext())
    let next = 0
    const applied = applyLayoutCommand(
      loaded.layout,
      { type: 'movePaneToNewTab', workspace: GIT_KEY, tabId: 'tab-host', leafId: leaf(3) },
      { mintId: () => `minted-${++next}`, mintLeafId: () => leaf(9), now: () => 1 }
    )
    if (!applied.ok) {
      throw new Error(`movePaneToNewTab refused: ${applied.code}`)
    }
    const saved = onDisk(saveWorkspaceLayout({ ...loaded, layout: applied.model }))
    const entries = saved.unifiedTabs?.[GIT_KEY] ?? []
    expect(entries.map((entry) => entry.id).sort()).toEqual(['minted-1', 'tab-host', 'tab-local'])
    for (const id of ['tab-host', 'minted-1']) {
      expect(entryOf(saved, id)).toMatchObject({
        executionHostId: 'runtime:env-a',
        projectHostSetupId: 42
      })
    }
  })

  it('publishes a stamped tab under its partition host, with no setup on the wire', () => {
    const stored = stampedSession({
      executionHostId: 'runtime:env-a',
      projectHostSetupId: 'setup-a'
    })
    const { layout } = loadWorkspaceLayout(LOCAL_EXECUTION_HOST_ID, stored, nameBasedLoadContext())
    const published = publishWorkspaceLayout(layout.workspaces[GIT_KEY]!, LOCAL_EXECUTION_HOST_ID)
    const tab = published.tabs.find((entry) => entry.id === 'tab-host')
    expect(tab?.executionHostId).toBe(LOCAL_EXECUTION_HOST_ID)
    expect(tab).not.toHaveProperty('projectHostSetupId')
    expect(tab).not.toHaveProperty('hostStamp')
  })
})
