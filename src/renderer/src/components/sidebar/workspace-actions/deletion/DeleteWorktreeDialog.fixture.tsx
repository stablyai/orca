import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { GitStatusEntry } from '../../../../../../shared/git/status/git-status-types'
import DeleteWorktreeDialog from './DeleteWorktreeDialog'
import { seedCloudWorkspaceSnapshot } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import { setArchiveTtlDaysForTest } from '@/lib/orca-cloud/archive-ttl'

const repo: Repo = {
  id: 'orca-plugins',
  path: '/Users/me/orca/orca-plugins',
  displayName: 'orca-plugins',
  badgeColor: '',
  addedAt: 1
}

const worktree: Worktree = {
  id: 'orca-plugins::/Users/me/orca/workspaces/orca-plugins/support-editable-excalidraw',
  repoId: repo.id,
  path: '/Users/me/orca/workspaces/orca-plugins/support-editable-excalidraw',
  displayName: 'Support editable .excalidraw.svg and .excalidraw.png files',
  branch: 'support-editable-excalidraw',
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

const dirtyEntries: GitStatusEntry[] = Array.from({ length: 13 }, (_, index) => ({
  path: `src/excalidraw/file-${index}.ts`,
  status: index % 3 === 0 ? 'untracked' : 'modified',
  area: index % 3 === 0 ? 'untracked' : 'unstaged'
}))

function dialogFixture(entries: GitStatusEntry[], interact?: (frame: HTMLElement) => void) {
  return defineFixture({
    width: 640,
    store: {
      repos: [repo],
      worktreesByRepo: { [repo.id]: [worktree] },
      gitStatusByWorktree: { [worktree.id]: entries },
      activeModal: 'delete-worktree',
      modalData: { worktreeId: worktree.id }
    },
    // The dialog portals to <body>; reserve room so the centered modal fits the frame.
    render: () => (
      <div className="h-[440px] bg-background">
        <DeleteWorktreeDialog />
      </div>
    ),
    interact
  })
}

export const dirty = dialogFixture(dirtyEntries)

export const clean = dialogFixture([])

export const alwaysDeleteMenu = dialogFixture(dirtyEntries, () => {
  document
    .querySelector<HTMLButtonElement>('[aria-label="More delete options"]')
    ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
})

/** An Orca Cloud workspace: sandbox + disk copy, Archive instead, no Force step (DS-07). */
export const cloudWorkspace = defineFixture({
  width: 640,
  store: {
    repos: [repo],
    worktreesByRepo: { [repo.id]: [worktree] },
    gitStatusByWorktree: { [worktree.id]: [] },
    activeModal: 'delete-worktree',
    modalData: { worktreeId: worktree.id }
  },
  setup: () => seedCloudWorkspaceSnapshot({ ids: new Set([worktree.id]), idsLoaded: true }),
  render: () => (
    <div className="h-[440px] bg-background">
      <DeleteWorktreeDialog />
    </div>
  )
})

/** Waits for an element the dialog renders after mount, then focuses it (opens its tooltip). */
async function focusWhenShown(find: () => HTMLElement | null | undefined): Promise<void> {
  const deadline = performance.now() + 3000
  let el = find()
  while (!el && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    el = find()
  }
  el?.focus()
}

/** "Archive instead" focused: the shared snapshot definition (until today + the archive TTL). */
export const cloudWorkspaceArchiveTooltip = defineFixture({
  ...cloudWorkspace,
  setup: () => {
    setArchiveTtlDaysForTest(30)
    return seedCloudWorkspaceSnapshot({ ids: new Set([worktree.id]), idsLoaded: true })
  },
  interact: () =>
    focusWhenShown(() =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) =>
        button.textContent?.includes('Archive instead')
      )
    )
})
