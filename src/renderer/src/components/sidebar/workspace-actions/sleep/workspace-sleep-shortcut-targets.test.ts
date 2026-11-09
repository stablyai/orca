import { describe, expect, it } from 'vitest'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { makeTerminalTab } from '@/store/terminals/terminal-row.test-fixture'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { resolveWorkspaceSleepShortcutTargets } from './workspace-sleep-shortcut-targets'

type State = Parameters<typeof resolveWorkspaceSleepShortcutTargets>[0]

const awake = (id: string): Worktree =>
  makeWorktree({ id: `repo::/work/${id}`, repoId: 'repo', hostId: 'local' })
const active = awake('active')
const hovered = awake('hovered')
const selected = awake('selected')
const idle = awake('idle')
const folder = makeFolderWorkspace({ id: 'notes', executionHostId: 'local' })

function makeState(overrides: Partial<State> = {}): State {
  const live = [active, hovered, selected, { id: 'folder:notes' }]
  return {
    activeWorkspaceExecutionHostId: 'local',
    activeWorktreeId: active.id,
    agentStatusByPaneKey: {},
    browserTabsByWorktree: {},
    deleteStateByWorktreeId: {},
    folderWorkspaces: [folder],
    ptyIdsByTabId: Object.fromEntries(live.map(({ id }) => [`tab-${id}`, [`pty-${id}`]])),
    structuredChatSleptAtByPaneKey: {},
    tabsByWorktree: Object.fromEntries(
      live.map(({ id }) => [id, [makeTerminalTab({ id: `tab-${id}`, worktreeId: id })]])
    ),
    unifiedTabsByWorktree: {},
    worktreesByRepo: { repo: [active, hovered, selected, idle] },
    ...overrides
  }
}

const pointerOn = (worktree: Pick<Worktree, 'id' | 'hostId'>) => ({
  workspaceId: worktree.id,
  hostIdentity: getWorktreeHostIdentity(worktree)
})
const ids = (worktrees: readonly Worktree[]): string[] => worktrees.map(({ id }) => id)

describe('resolveWorkspaceSleepShortcutTargets', () => {
  it('sleeps every awake workspace in a selection that holds the hovered card', () => {
    const targets = resolveWorkspaceSleepShortcutTargets(
      makeState(),
      [hovered, selected, idle],
      pointerOn(hovered)
    )
    expect(ids(targets)).toEqual(['repo::/work/hovered', 'repo::/work/selected'])
  })

  it('sleeps only the hovered card when it is outside the selection', () => {
    const targets = resolveWorkspaceSleepShortcutTargets(
      makeState(),
      [selected, idle],
      pointerOn(hovered)
    )
    expect(ids(targets)).toEqual(['repo::/work/hovered'])
  })

  it('sleeps a hovered folder workspace', () => {
    const targets = resolveWorkspaceSleepShortcutTargets(
      makeState(),
      [],
      pointerOn({ id: 'folder:notes', hostId: 'local' })
    )
    expect(ids(targets)).toEqual(['folder:notes'])
  })

  it('sleeps the active workspace when no card is hovered', () => {
    expect(ids(resolveWorkspaceSleepShortcutTargets(makeState(), [], null))).toEqual([
      'repo::/work/active'
    ])
  })

  it('sleeps nothing when the hovered card has nothing to sleep', () => {
    expect(resolveWorkspaceSleepShortcutTargets(makeState(), [], pointerOn(idle))).toEqual([])
  })

  it('sleeps nothing while a workspace in the selection is being deleted', () => {
    const state = makeState({
      deleteStateByWorktreeId: {
        [getWorktreeHostIdentity(selected)]: {
          isDeleting: true,
          error: null,
          canForceDelete: false,
          forceDeleteReason: null
        }
      }
    })
    expect(
      resolveWorkspaceSleepShortcutTargets(state, [hovered, selected], pointerOn(hovered))
    ).toEqual([])
  })
})
