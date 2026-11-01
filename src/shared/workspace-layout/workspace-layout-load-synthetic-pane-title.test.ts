// Main must drop a lone pane title that repeats its tab name, matching window restore and its next save.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../execution-host'
import type { Tab } from '../tab-types'
import type { TerminalLayoutSnapshot } from '../terminal-tab-types'
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
const NAME = 'Production agent session'

function titledPaneSession(
  key: string,
  paneTitles: TerminalLayoutSnapshot['titlesByLeafId'],
  {
    split = false,
    hostId = LOCAL_EXECUTION_HOST_ID,
    entry
  }: { split?: boolean; hostId?: ExecutionHostId; entry?: Partial<Tab> } = {}
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
            leaves: split
              ? [
                  [leaf(1), 'pty-a'],
                  [leaf(2), 'pty-b']
                ]
              : [[leaf(1), 'pty-a']],
            row: { title: NAME, customTitle: NAME },
            ...(entry ? { entry } : {}),
            layout: { titlesByLeafId: paneTitles }
          }
        ]
      }
    ],
    hostId
  )
}

function paneTitles(hostId: ExecutionHostId, key: string, session: WorkspaceSessionState) {
  expect(checkLayoutRoundTrip(hostId, session).findings).toEqual([])
  const loaded = loadWorkspaceLayout(hostId, session, {
    mintId: (seed) => `minted-${seed}`,
    mintLeafId: (seed) => `minted-${seed}`
  })
  const leaves = loaded.layout.workspaces[key]?.leaves ?? {}
  return Object.fromEntries(
    Object.entries(leaves).flatMap(([id, item]) =>
      item.title === undefined ? [] : [[id, item.title]]
    )
  )
}

describe('Loader: a pane title that only repeats its tab’s name', () => {
  beforeEach(() => {
    layoutOwner.isMain = true
  })

  it.each<[string, ExecutionHostId, string]>([
    ['git worktree', LOCAL_EXECUTION_HOST_ID, GIT_KEY],
    ['folder workspace', LOCAL_EXECUTION_HOST_ID, FOLDER_KEY],
    ['SSH workspace', SSH_HOST, SSH_KEY]
  ])('is dropped in a %s', (_name, hostId, key) => {
    const session = titledPaneSession(key, { [leaf(1)]: NAME }, { hostId })
    expect(paneTitles(hostId, key, session)).toEqual({})
  })

  it('is dropped when it repeats a quick command label only the tab bar stores', () => {
    const session = titledPaneSession(
      GIT_KEY,
      { [leaf(1)]: 'npm test' },
      { entry: { quickCommandLabel: ' npm test ' } }
    )
    expect(paneTitles(LOCAL_EXECUTION_HOST_ID, GIT_KEY, session)).toEqual({})
  })

  it('is dropped when it repeats the tab bar label, the live title the window loads', () => {
    const session = titledPaneSession(
      GIT_KEY,
      { [leaf(1)]: 'build watcher' },
      { entry: { label: 'build watcher' } }
    )
    expect(paneTitles(LOCAL_EXECUTION_HOST_ID, GIT_KEY, session)).toEqual({})
  })

  it('keeps it in a split tab, where it names one pane among several', () => {
    const session = titledPaneSession(GIT_KEY, { [leaf(1)]: NAME }, { split: true })
    expect(paneTitles(LOCAL_EXECUTION_HOST_ID, GIT_KEY, session)).toEqual({ [leaf(1)]: NAME })
  })

  it('keeps it while the window owns the layout', () => {
    layoutOwner.isMain = false
    const session = titledPaneSession(GIT_KEY, { [leaf(1)]: NAME })
    expect(paneTitles(LOCAL_EXECUTION_HOST_ID, GIT_KEY, session)).toEqual({ [leaf(1)]: NAME })
  })
})
