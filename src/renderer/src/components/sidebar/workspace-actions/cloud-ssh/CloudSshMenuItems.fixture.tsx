import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { CloudSshStatus } from '../../../../../../shared/cloud-ssh'
import type { PublicKnownRuntimeEnvironment } from '../../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import WorktreeContextMenu from '../context-menu/WorktreeContextMenu'

const ENVIRONMENT_ID = 'env-cloud'
let fixtureCount = 0

const repo: Repo = {
  id: 'orca',
  path: '/vercel/sandbox/project',
  displayName: 'orca',
  badgeColor: '',
  addedAt: 1
}

const worktree: Worktree = {
  id: 'orca::/vercel/orca/workspaces/project/fix-login',
  repoId: repo.id,
  hostId: `runtime:${ENVIRONMENT_ID}`,
  runtimeOwnerEnvironmentId: ENVIRONMENT_ID,
  instanceId: 'fix-login',
  path: '/vercel/orca/workspaces/project/fix-login',
  displayName: 'Fix login bug',
  branch: 'fix-login',
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

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture needs only the fields the menu reads.
const environment = {
  id: ENVIRONMENT_ID,
  name: 'Orca Cloud',
  source: 'ephemeral-vm'
} as unknown as PublicKnownRuntimeEnvironment

function sshMenuFixture(status: CloudSshStatus | 'loading', submenu: 'SSH' | 'Open in' = 'SSH') {
  // A distinct row per fixture: the menu caches status per workspace.
  const row = { ...worktree, id: `${worktree.id}-${++fixtureCount}` }
  return defineFixture({
    width: 560,
    store: {
      repos: [repo],
      worktreesByRepo: { [repo.id]: [row] },
      runtimeEnvironments: [environment]
    },
    setup: () => {
      window.api.ephemeralVm = {
        ...window.api.ephemeralVm,
        cloudSshStatus: () =>
          status === 'loading' ? new Promise<CloudSshStatus>(() => {}) : Promise.resolve(status)
      }
    },
    render: () => (
      <div className="h-[460px] bg-background p-4 text-foreground">
        <WorktreeContextMenu worktree={row}>
          <div className="text-sm">Fix login bug</div>
        </WorktreeContextMenu>
      </div>
    ),
    interact: async (frame) => {
      frame.querySelector('[data-worktree-context-menu-scope]')?.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 16,
          clientY: 40
        })
      )
      for (let i = 0; i < 20; i++) {
        await new Promise(requestAnimationFrame)
        const trigger = Array.from(
          frame.ownerDocument.querySelectorAll<HTMLElement>(
            '[data-slot="dropdown-menu-sub-trigger"]'
          )
        ).find((item) => item.textContent === submenu)
        if (trigger) {
          trigger.focus()
          trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
          return
        }
      }
    }
  })
}

const editors: CloudSshStatus['editors'] = [
  { id: 'builtin:vscode', label: 'VS Code', kind: 'vscode' },
  { id: 'builtin:cursor', label: 'Cursor', kind: 'cursor' }
]

export const firstUse = sshMenuFixture({
  cloud: true,
  hasAccess: false,
  asleep: true,
  alias: null,
  includeInstalled: false,
  editors
})

export const withAccess = sshMenuFixture({
  cloud: true,
  hasAccess: true,
  asleep: false,
  alias: 'orca-fix-login-bug-8d01',
  includeInstalled: true,
  editors
})

export const noEditors = sshMenuFixture(
  {
    cloud: true,
    hasAccess: true,
    asleep: false,
    alias: 'orca-fix-login-bug-8d01',
    includeInstalled: false,
    editors: []
  },
  'Open in'
)

export const openInOverSsh = sshMenuFixture(
  {
    cloud: true,
    hasAccess: true,
    asleep: false,
    alias: 'orca-fix-login-bug-8d01',
    includeInstalled: true,
    editors
  },
  'Open in'
)

export const loading = sshMenuFixture('loading', 'Open in')
