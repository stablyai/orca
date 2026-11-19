import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { Repo } from '../../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import type { GitStatusEntry } from '../../../../../shared/git/status/git-status-types'
import DeleteWorktreeDialog from '../../sidebar/workspace-actions/deletion/DeleteWorktreeDialog'

const repo: Repo = {
  id: 'zotz',
  path: '/Users/me/code/zotz',
  displayName: 'zotz',
  badgeColor: '',
  addedAt: 1
}

const worktree: Worktree = {
  id: 'zotz::/Users/me/code/workspaces/zotz/segundo-plano',
  repoId: repo.id,
  path: '/Users/me/code/workspaces/zotz/segundo-plano',
  displayName: 'Pestaña Segundo plano',
  branch: 'zotz/segundo-plano',
  head: 'abc123',
  isBare: false,
  isMainWorktree: false,
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1
}

const entries: GitStatusEntry[] = [
  {
    path: 'src/renderer/src/components/zotz/background/ZotzBackgroundPanel.tsx',
    status: 'modified',
    area: 'unstaged'
  },
  { path: 'docs/zotz/PLAN.md', status: 'modified', area: 'unstaged' },
  { path: 'notes/todo.md', status: 'untracked', area: 'untracked' }
]

const original = [
  'export function ZotzBackgroundPanel() {',
  '  return (',
  '    <div className="flex flex-col">',
  '      <div className="peer flex flex-col" />',
  '    </div>',
  '  )',
  '}'
].join('\n')
const modified = original.replace(
  '      <div className="peer flex flex-col" />',
  '      <div className="peer flex flex-col [&_.max-h-40]:max-h-none" />\n      <ZotzBackgroundEmpty />'
)

function clickFirst(selector: string): void {
  document.querySelector<HTMLElement>(selector)?.click()
}

export const withDiff = defineFixture({
  width: 720,
  store: {
    repos: [repo],
    worktreesByRepo: { [repo.id]: [worktree] },
    gitStatusByWorktree: { [worktree.id]: entries },
    activeModal: 'delete-worktree',
    modalData: { worktreeId: worktree.id }
  },
  setup: () => {
    window.api.git.diff = async () => ({
      kind: 'text',
      originalContent: original,
      modifiedContent: modified,
      originalIsBinary: false,
      modifiedIsBinary: false
    })
  },
  render: () => (
    <div className="h-[640px] bg-background">
      <DeleteWorktreeDialog />
    </div>
  ),
  interact: async () => {
    // Open the changed-files popover, then expand the first file's diff.
    clickFirst('[role="dialog"] button[aria-haspopup="dialog"]')
    await new Promise((resolve) => setTimeout(resolve, 150))
    clickFirst('[data-radix-popper-content-wrapper] button[aria-expanded]')
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
})
