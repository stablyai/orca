// One terminal bound in two panes of one tab: with main owning the layout, the Loader keeps one
// pane as the window does, so main's frames never draw the duplicate.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../execution-host'
import type { WorkspaceSessionState } from '../workspace-session-state-types'
import { loadWorkspaceLayout } from './workspace-layout-load'
import { checkLayoutRoundTrip } from './workspace-layout-round-trip-check'
import {
  addWorkspace,
  emptySession,
  FOLDER_KEY,
  GIT_KEY,
  leaf,
  SSH_KEY
} from './workspace-layout-session.test-fixture'

const layoutOwner = vi.hoisted(() => ({ isMain: true }))
vi.mock('../layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return layoutOwner.isMain
  }
}))

const SSH_HOST: ExecutionHostId = 'ssh:box'

function duplicatePtySession(
  key: string,
  activeLeaf = leaf(1),
  hostId: ExecutionHostId = LOCAL_EXECUTION_HOST_ID
): WorkspaceSessionState {
  return addWorkspace(
    emptySession(),
    key,
    [
      {
        id: 'g1',
        tabs: [
          {
            id: 'tab-a',
            leaves: [
              [leaf(1), 'pty-a'],
              [leaf(2), 'pty-a']
            ],
            layout: {
              activeLeafId: activeLeaf,
              titlesByLeafId: { [leaf(2)]: 'second' },
              buffersByLeafId: { [leaf(2)]: 'scrollback' }
            }
          }
        ]
      }
    ],
    hostId
  )
}

function load(hostId: ExecutionHostId, session: WorkspaceSessionState) {
  expect(checkLayoutRoundTrip(hostId, session).findings).toEqual([])
  let next = 0
  return loadWorkspaceLayout(hostId, session, {
    mintId: () => `minted-${++next}`,
    mintLeafId: () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`
  })
}

describe('Loader: one terminal in two panes of one tab', () => {
  beforeEach(() => {
    layoutOwner.isMain = true
  })

  it.each<[string, ExecutionHostId, string]>([
    ['git worktree', LOCAL_EXECUTION_HOST_ID, GIT_KEY],
    ['folder workspace', LOCAL_EXECUTION_HOST_ID, FOLDER_KEY],
    ['SSH workspace', SSH_HOST, SSH_KEY]
  ])('keeps one pane bound to it in a %s', (_name, hostId, key) => {
    const loaded = load(hostId, duplicatePtySession(key, leaf(1), hostId))
    const workspace = loaded.layout.workspaces[key]!
    const tab = workspace.tabs.find((candidate) => candidate.id === 'tab-a')
    expect(tab?.kind === 'terminal' ? tab.panes.root : undefined).toEqual({
      type: 'leaf',
      leafId: leaf(1)
    })
    expect(workspace.leaves?.[leaf(1)]?.ptyId).toBe('pty-a')
    expect(workspace.leaves?.[leaf(2)]).toBeUndefined()
    // The removed pane's title and scrollback move to the kept one, as the window's rule does.
    expect(workspace.leaves?.[leaf(1)]?.title).toBe('second')
    expect(loaded.facts.scrollback[leaf(1)]).toEqual({ buffer: 'scrollback' })
    expect(loaded.desktopView.panes['tab-a']).toEqual({
      activeLeafId: leaf(1),
      expandedLeafId: null
    })
  })

  it('keeps the focused pane when it is the later one', () => {
    const loaded = load(LOCAL_EXECUTION_HOST_ID, duplicatePtySession(GIT_KEY, leaf(2)))
    const workspace = loaded.layout.workspaces[GIT_KEY]!
    const tab = workspace.tabs.find((candidate) => candidate.id === 'tab-a')
    expect(tab?.kind === 'terminal' ? tab.panes.root : undefined).toEqual({
      type: 'leaf',
      leafId: leaf(2)
    })
    expect(workspace.leaves?.[leaf(2)]?.ptyId).toBe('pty-a')
    expect(loaded.desktopView.panes['tab-a']?.activeLeafId).toBe(leaf(2))
  })

  it('leaves both panes in place while the window owns the layout', () => {
    layoutOwner.isMain = false
    const loaded = load(LOCAL_EXECUTION_HOST_ID, duplicatePtySession(GIT_KEY))
    const workspace = loaded.layout.workspaces[GIT_KEY]!
    const tab = workspace.tabs.find((candidate) => candidate.id === 'tab-a')
    expect(tab?.kind === 'terminal' ? tab.panes.root?.type : undefined).toBe('split')
    expect(workspace.leaves?.[leaf(1)]?.ptyId).toBe('pty-a')
    expect(workspace.leaves?.[leaf(2)]?.ptyId).toBeUndefined()
  })
})
