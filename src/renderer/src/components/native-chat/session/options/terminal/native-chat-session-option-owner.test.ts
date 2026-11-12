// @vitest-environment happy-dom

import { createElement } from 'react'
import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import type { Repo } from '../../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../../shared/worktree/types'
import { createGlobalSettingsFixture } from '../../../../../../../shared/global-settings-test-fixture'
import { makeTab } from '../../../../../store/terminals/terminal-tab.test-fixture'
import { useNativeChatSessionOptionOwner } from './native-chat-session-option-owner'

// The sidebar's separate catalog index is outside the owner-index measurement.
vi.mock('@/store/slices/ui/settled-sort-epoch', () => ({ installSettledSortEpoch: vi.fn() }))

const initialState = useAppStore.getInitialState()

function repo(index: number): Repo {
  return {
    id: `repo-${index}`,
    path: `/repo-${index}`,
    displayName: `Repo ${index}`,
    badgeColor: '',
    addedAt: 0
  }
}

function worktree(index: number): Worktree {
  return {
    id: `repo-${index}::/repo-${index}`,
    repoId: `repo-${index}`,
    path: `/repo-${index}`,
    head: 'abc123',
    branch: 'main',
    isBare: false,
    isMainWorktree: true,
    displayName: `Repo ${index}`,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

describe('terminal option owner catalog invalidation', () => {
  afterEach(() => useAppStore.setState(initialState, true))

  it.each([10, 100])(
    'shares catalog indexing across %i mounted panes and updates only the changed owner',
    (count) => {
      const rows = Array.from({ length: count }, (_, index) => worktree(index))
      const repos = rows.map((_, index) => repo(index))
      const worktreesByRepo = Object.fromEntries(rows.map((row) => [row.repoId, [row]]))
      useAppStore.setState({
        repos,
        worktreesByRepo,
        tabsByWorktree: Object.fromEntries(
          rows.map((row, index) => [
            row.id,
            [makeTab({ id: `tab-${index}`, worktreeId: row.id, ptyId: `pty-${index}` })]
          ])
        )
      })
      const renders = Array.from({ length: count }, () => 0)
      const connections: (string | null | undefined)[] = []
      function Probe({ index }: { index: number }): null {
        renders[index]++
        const owner = useNativeChatSessionOptionOwner({
          agent: 'grok',
          terminalTabId: `tab-${index}`,
          targetPtyId: `pty-${index}`
        })
        connections[index] = owner?.binding.connectionId
        return null
      }
      const mounted = render(
        createElement(
          'div',
          null,
          ...rows.map((_, index) => createElement(Probe, { key: index, index }))
        )
      )
      renders.fill(0)
      let worktreeCatalogEnumerations = 0
      let terminalCatalogEnumerations = 0
      let repoRowsRead = 0
      const nextTabs = new Proxy(
        { ...useAppStore.getState().tabsByWorktree },
        {
          ownKeys(target) {
            terminalCatalogEnumerations++
            return Reflect.ownKeys(target)
          }
        }
      )
      const nextWorktrees = new Proxy(
        { ...worktreesByRepo },
        {
          ownKeys(target) {
            worktreeCatalogEnumerations++
            return Reflect.ownKeys(target)
          }
        }
      )
      const nextRepos = new Proxy([...repos], {
        get(target, key) {
          if (typeof key === 'string' && /^\d+$/.test(key)) {
            repoRowsRead++
          }
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The plain Repo[] fixture preserves string/symbol reads, including undefined for absent keys.
          return target[key as keyof typeof target]
        }
      })
      act(() =>
        useAppStore.setState({
          repos: nextRepos,
          worktreesByRepo: nextWorktrees,
          tabsByWorktree: nextTabs
        })
      )
      // One listing pass per new immutable catalog, independent of mounted consumers.
      expect(worktreeCatalogEnumerations).toBe(1)
      expect(terminalCatalogEnumerations).toBe(1)
      // Three existing GitHub cache passes plus one shared owner-index pass.
      expect(repoRowsRead).toBe(4 * count)
      expect(renders).toEqual(Array.from({ length: count }, () => 0))
      act(() => useAppStore.setState({ settings: createGlobalSettingsFixture() }))
      expect(worktreeCatalogEnumerations).toBe(1)
      expect(terminalCatalogEnumerations).toBe(1)
      expect(repoRowsRead).toBe(4 * count)
      expect(renders).toEqual(Array.from({ length: count }, () => 0))

      act(() =>
        useAppStore.setState({
          repos: repos.map((row, index) =>
            index === 0 ? { ...row, connectionId: 'ssh-owner' } : row
          )
        })
      )
      expect(renders[0]).toBeGreaterThan(0)
      expect(connections[0]).toBe('ssh-owner')
      expect(renders.slice(1)).toEqual(Array.from({ length: count - 1 }, () => 0))
      mounted.unmount()
    }
  )
})
