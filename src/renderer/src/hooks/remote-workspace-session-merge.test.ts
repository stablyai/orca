import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { TerminalTab, WorkspaceSessionState } from '../../../shared/types'
import { mergeDirectSshRemoteWorkspaceSession } from './remote-workspace-session-merge'

const ATLAS = 'repo-1::/home/atlas-eval'
const MAIN = 'repo-1::/home/main'

function tab(id: string, worktreeId: string): TerminalTab {
  return {
    id,
    worktreeId,
    ptyId: `ssh:target-1@@${id}`,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function session(overrides: Partial<WorkspaceSessionState>): WorkspaceSessionState {
  return { ...getDefaultWorkspaceSession(), ...overrides }
}

describe('mergeDirectSshRemoteWorkspaceSession', () => {
  it('preserves the locally selected durable tab when the remote snapshot still contains it', () => {
    const codexTab = tab('tab-codex', ATLAS)
    const shellTab = tab('tab-shell', ATLAS)
    const current = session({
      activeRepoId: 'repo-1',
      activeWorktreeId: ATLAS,
      activeWorkspaceKey: `worktree:${MAIN}`,
      activeTabId: codexTab.id,
      activeTabIdByWorktree: { [ATLAS]: codexTab.id },
      tabsByWorktree: { [ATLAS]: [codexTab, shellTab] }
    })
    const remote = session({
      activeRepoId: 'repo-1',
      activeWorktreeId: MAIN,
      activeTabId: 'tab-main',
      activeTabIdByWorktree: { [ATLAS]: shellTab.id, [MAIN]: 'tab-main' },
      tabsByWorktree: {
        [ATLAS]: [codexTab, shellTab],
        [MAIN]: [tab('tab-main', MAIN)]
      }
    })

    const merged = mergeDirectSshRemoteWorkspaceSession(
      current,
      remote,
      new Set([ATLAS, MAIN]),
      current.tabsByWorktree,
      new Set()
    )

    expect(merged.activeWorktreeId).toBe(ATLAS)
    expect(merged.activeWorkspaceKey).toBe(`worktree:${ATLAS}`)
    expect(merged.activeTabId).toBe(codexTab.id)
    expect(merged.activeTabIdByWorktree?.[ATLAS]).toBe(codexTab.id)
  })

  it('uses the remote selection when the former local tab no longer exists', () => {
    const current = session({
      activeRepoId: 'repo-1',
      activeWorktreeId: ATLAS,
      activeTabId: 'tab-gone',
      activeTabIdByWorktree: { [ATLAS]: 'tab-gone' },
      tabsByWorktree: { [ATLAS]: [tab('tab-gone', ATLAS)] }
    })
    const remoteTab = tab('tab-remote', ATLAS)
    const remote = session({
      activeRepoId: 'repo-1',
      activeWorktreeId: ATLAS,
      activeTabId: remoteTab.id,
      activeTabIdByWorktree: { [ATLAS]: remoteTab.id },
      tabsByWorktree: { [ATLAS]: [remoteTab] }
    })

    const merged = mergeDirectSshRemoteWorkspaceSession(
      current,
      remote,
      new Set([ATLAS]),
      current.tabsByWorktree,
      new Set()
    )

    expect(merged.activeTabId).toBe(remoteTab.id)
    expect(merged.activeTabIdByWorktree?.[ATLAS]).toBe(remoteTab.id)
  })

  it('keeps a locally reattached durable tab omitted by a stale remote snapshot', () => {
    const codexTab = tab('tab-codex', ATLAS)
    const remoteTab = tab('tab-remote', ATLAS)
    const current = session({
      activeRepoId: 'repo-1',
      activeWorktreeId: ATLAS,
      activeWorkspaceKey: `worktree:${ATLAS}`,
      activeTabId: codexTab.id,
      activeTabIdByWorktree: { [ATLAS]: codexTab.id },
      tabsByWorktree: { [ATLAS]: [codexTab] },
      terminalLayoutsByTabId: {
        [codexTab.id]: {
          root: { type: 'leaf', leafId: 'leaf-codex' },
          activeLeafId: 'leaf-codex',
          expandedLeafId: null,
          ptyIdsByLeafId: { 'leaf-codex': codexTab.ptyId! }
        }
      },
      remoteSessionIdsByTabId: { [codexTab.id]: codexTab.ptyId! }
    })
    const remote = session({
      activeRepoId: 'repo-1',
      activeWorktreeId: ATLAS,
      activeTabId: remoteTab.id,
      activeTabIdByWorktree: { [ATLAS]: remoteTab.id },
      tabsByWorktree: { [ATLAS]: [remoteTab] }
    })

    const merged = mergeDirectSshRemoteWorkspaceSession(
      current,
      remote,
      new Set([ATLAS]),
      current.tabsByWorktree,
      new Set([codexTab.id])
    )

    expect(merged.tabsByWorktree[ATLAS]).toEqual([remoteTab, codexTab])
    expect(merged.activeTabId).toBe(codexTab.id)
    expect(merged.activeTabIdByWorktree?.[ATLAS]).toBe(codexTab.id)
    expect(merged.terminalLayoutsByTabId[codexTab.id]).toEqual(
      current.terminalLayoutsByTabId[codexTab.id]
    )
    expect(merged.remoteSessionIdsByTabId?.[codexTab.id]).toBe(codexTab.ptyId)
  })

  it('does not rewrite an active folder workspace outside the SSH target', () => {
    const folderKey = 'folder:folder-1'
    const current = session({
      activeRepoId: null,
      activeWorktreeId: folderKey,
      activeWorkspaceKey: folderKey,
      activeTabId: 'folder-tab'
    })
    const remote = session({
      activeRepoId: 'repo-1',
      activeWorktreeId: ATLAS,
      activeTabId: 'tab-remote',
      activeTabIdByWorktree: { [ATLAS]: 'tab-remote' },
      tabsByWorktree: { [ATLAS]: [tab('tab-remote', ATLAS)] }
    })

    const merged = mergeDirectSshRemoteWorkspaceSession(
      current,
      remote,
      new Set([ATLAS]),
      {},
      new Set()
    )

    expect(merged.activeWorktreeId).toBe(folderKey)
    expect(merged.activeWorkspaceKey).toBe(folderKey)
    expect(merged.activeTabId).toBe('folder-tab')
  })
})
