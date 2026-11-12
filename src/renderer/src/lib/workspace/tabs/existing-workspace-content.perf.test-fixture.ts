import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { makeTab } from '@/store/terminals/terminal-tab.test-fixture'
import { makeBrowserTab } from '@/store/slices/browser/browser-tab.test-fixture'
import { makeUnifiedTab, makeTabGroup } from '@/store/slices/tabs/tab-group.test-fixture'

export function installContentFleet(count: number, readRow: (index: number) => void) {
  const rows = Array.from({ length: count }, (_, index) => ({
    ...makeWorktree({
      id: `repo::/${index}/.bare`,
      repoId: 'repo',
      path: `/${index}/.bare`,
      isBare: true,
      hostId: 'local'
    }),
    get id() {
      readRow(index)
      return `repo::/${index}/.bare`
    },
    get path() {
      readRow(index)
      return `/${index}/.bare`
    },
    get isBare() {
      readRow(index)
      return true
    },
    ownership: 'external' as const,
    selectedCheckout: false,
    visible: false
  }))
  const ids = rows.slice(0, -1).map((row) => row.id)
  useAppStore.setState(
    {
      ...useAppStore.getInitialState(),
      repos: [
        {
          id: 'repo',
          path: '/repo',
          displayName: 'Repo',
          badgeColor: '',
          addedAt: 0,
          executionHostId: 'local'
        }
      ],
      worktreesByRepo: {},
      detectedWorktreesByRepo: {
        repo: { repoId: 'repo', authoritative: true, source: 'git', worktrees: rows }
      },
      activeWorktreeId: 'repo::/0/.bare',
      activeWorkspaceExecutionHostId: 'local',
      tabsByWorktree: Object.fromEntries(
        ids.map((id) => [id, [makeTab({ id: `shell:${id}`, worktreeId: id })]])
      ),
      browserTabsByWorktree: Object.fromEntries(
        ids.map((id) => [
          id,
          [
            makeBrowserTab({
              id: `browser:${id}`,
              worktreeId: id,
              url: 'https://example.test/saved'
            })
          ]
        ])
      ),
      unifiedTabsByWorktree: Object.fromEntries(
        ids.map((id) => [
          id,
          [
            makeUnifiedTab({
              id: `wrapper:${id}`,
              entityId: `browser:${id}`,
              worktreeId: id,
              groupId: `group:${id}`,
              contentType: 'browser',
              executionHostId: 'local'
            })
          ]
        ])
      ),
      groupsByWorktree: Object.fromEntries(
        ids.map((id) => [
          id,
          [
            makeTabGroup({
              id: `group:${id}`,
              worktreeId: id,
              activeTabId: `wrapper:${id}`,
              tabOrder: [`wrapper:${id}`]
            })
          ]
        ])
      ),
      activeGroupIdByWorktree: Object.fromEntries(ids.map((id) => [id, `group:${id}`]))
    },
    true
  )
  return rows
}
