import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '../../store'
import {
  clearWorktreeTabDropHighlight,
  resolveHoveredWorktreeDropTarget,
  syncWorktreeTabDropHighlight
} from './cross-worktree-tab-drop'
import {
  moveTabToTargetWorktree,
  resolveMoveToWorktreeTargets
} from '../tab-bar/tab-move-to-pane-column'

describe('cross-worktree tab drag-and-drop & Move to Workspace', () => {
  const sourceWorktreeId = 'repo-alpha::/tmp/worktrees/alpha'
  const targetWorktreeId = 'repo-alpha::/tmp/worktrees/beta'
  const tabId = 'tab-1'
  const ptyId = 'pty-live-handle-1'
  const sessionTitle = 'Orca Tab DnD Session'

  beforeEach(() => {
    useAppStore.setState({
      activeWorktreeId: sourceWorktreeId,
      worktreesByRepo: {
        'repo-alpha': [
          {
            id: sourceWorktreeId,
            repoId: 'repo-alpha',
            path: '/tmp/worktrees/alpha',
            head: 'abc1234',
            branch: 'refs/heads/main',
            isBare: false,
            isMainWorktree: true,
            displayName: 'main',
            comment: '',
            linkedIssue: null,
            linkedPR: null,
            linkedLinearIssue: null,
            linkedGitLabMR: null,
            linkedGitLabIssue: null,
            isArchived: false,
            isUnread: false,
            isPinned: false,
            sortOrder: 1,
            lastActivityAt: 100,
            workspaceStatus: 'in-progress'
          },
          {
            id: targetWorktreeId,
            repoId: 'repo-alpha',
            path: '/tmp/worktrees/beta',
            head: 'def5678',
            branch: 'refs/heads/feature/beta',
            isBare: false,
            isMainWorktree: false,
            displayName: 'feature/beta',
            comment: '',
            linkedIssue: null,
            linkedPR: null,
            linkedLinearIssue: null,
            linkedGitLabMR: null,
            linkedGitLabIssue: null,
            isArchived: false,
            isUnread: false,
            isPinned: false,
            sortOrder: 2,
            lastActivityAt: 200,
            workspaceStatus: 'in-progress'
          }
        ]
      },
      tabsByWorktree: {
        [sourceWorktreeId]: [
          {
            id: tabId,
            ptyId,
            worktreeId: sourceWorktreeId,
            title: 'zsh',
            customTitle: sessionTitle,
            color: '#3b82f6',
            sortOrder: 0,
            createdAt: 1000
          }
        ]
      },
      unifiedTabsByWorktree: {
        [sourceWorktreeId]: [
          {
            id: tabId,
            entityId: tabId,
            worktreeId: sourceWorktreeId,
            groupId: 'group-src',
            contentType: 'terminal',
            label: sessionTitle,
            customTitle: sessionTitle,
            color: '#3b82f6',
            sortOrder: 0,
            createdAt: 1000
          }
        ]
      },
      groupsByWorktree: {
        [sourceWorktreeId]: [
          {
            id: 'group-src',
            worktreeId: sourceWorktreeId,
            activeTabId: tabId,
            tabOrder: [tabId]
          }
        ]
      },
      layoutByWorktree: {
        [sourceWorktreeId]: { type: 'leaf', groupId: 'group-src' }
      },
      activeGroupIdByWorktree: {
        [sourceWorktreeId]: 'group-src'
      },
      activeTabIdByWorktree: {
        [sourceWorktreeId]: tabId
      },
      activeTabTypeByWorktree: {
        [sourceWorktreeId]: 'terminal'
      },
      ptyIdsByTabId: {
        [tabId]: [ptyId]
      },
      tabLayoutsByTabId: {
        [tabId]: {
          root: { type: 'leaf', id: 'pane-1', ptyId },
          activeLeafId: 'pane-1',
          expandedLeafId: null
        }
      }
    })
  })

  it('moves a terminal tab across worktrees while preserving ptyId and customTitle', () => {
    const moved = useAppStore.getState().moveTabToWorktree(tabId, targetWorktreeId)
    expect(moved).toBe(true)

    const next = useAppStore.getState()
    expect(next.unifiedTabsByWorktree[sourceWorktreeId] ?? []).toHaveLength(0)
    expect(next.tabsByWorktree[sourceWorktreeId] ?? []).toHaveLength(0)

    const targetUnified = next.unifiedTabsByWorktree[targetWorktreeId] ?? []
    expect(targetUnified).toHaveLength(1)
    expect(targetUnified[0]).toMatchObject({
      id: tabId,
      worktreeId: targetWorktreeId,
      customTitle: sessionTitle,
      label: sessionTitle
    })

    const targetLegacy = next.tabsByWorktree[targetWorktreeId] ?? []
    expect(targetLegacy).toHaveLength(1)
    expect(targetLegacy[0]).toMatchObject({
      id: tabId,
      ptyId,
      worktreeId: targetWorktreeId,
      customTitle: sessionTitle
    })

    // Live PTY binding and pane layout must remain intact (zero session respawn)
    expect(next.ptyIdsByTabId[tabId]).toEqual([ptyId])
    expect(next.tabLayoutsByTabId[tabId]?.root).toMatchObject({
      type: 'leaf',
      id: 'pane-1',
      ptyId
    })
  })

  it('lists non-source worktrees in resolveMoveToWorktreeTargets and moves via context menu', () => {
    const targets = resolveMoveToWorktreeTargets(tabId)
    expect(targets).toEqual([
      {
        id: targetWorktreeId,
        label: 'feature/beta'
      }
    ])

    const moved = moveTabToTargetWorktree(tabId, targetWorktreeId)
    expect(moved).toBe(true)
    expect(useAppStore.getState().activeTabIdByWorktree[targetWorktreeId]).toBe(tabId)
  })

  it('resolves and highlights hovered sidebar worktree drop cards', () => {
    const fakeCard = {
      attrs: new Map<string, string>([
        ['data-worktree-card-surface', 'true'],
        ['data-worktree-id', targetWorktreeId]
      ]),
      getAttribute(name: string) {
        return this.attrs.get(name) ?? null
      },
      setAttribute(name: string, value: string) {
        this.attrs.set(name, value)
      },
      removeAttribute(name: string) {
        this.attrs.delete(name)
      },
      closest(selector: string) {
        if (selector.includes('data-worktree-card-surface')) {
          return this as unknown as Element
        }
        return null
      }
    }

    const fakeRoot = {
      querySelectorAll() {
        return fakeCard.getAttribute('data-worktree-tab-drop-target') === 'true'
          ? ([fakeCard] as unknown as NodeListOf<Element>)
          : ([] as unknown as NodeListOf<Element>)
      }
    } as unknown as ParentNode

    const dragEvent = {
      activatorEvent: { clientX: 200, clientY: 120 } as unknown as Event,
      delta: { x: -120, y: 40 }
    }

    const resolved = resolveHoveredWorktreeDropTarget(
      dragEvent,
      sourceWorktreeId,
      () => fakeCard as unknown as Element
    )
    expect(resolved?.targetWorktreeId).toBe(targetWorktreeId)

    const highlightedId = syncWorktreeTabDropHighlight(dragEvent, sourceWorktreeId, {
      elementFromPoint: () => fakeCard as unknown as Element,
      root: fakeRoot
    })
    expect(highlightedId).toBe(targetWorktreeId)
    expect(fakeCard.getAttribute('data-worktree-tab-drop-target')).toBe('true')

    clearWorktreeTabDropHighlight(fakeRoot)
    expect(fakeCard.getAttribute('data-worktree-tab-drop-target')).toBeNull()
  })
})
