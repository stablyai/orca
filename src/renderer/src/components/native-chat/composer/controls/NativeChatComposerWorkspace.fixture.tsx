import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getDefaultSettings } from '../../../../../../shared/orca-profiles/constants'
import { NativeChatComposerWorkspace } from './NativeChatComposerWorkspace'
import { nativeChatAppearanceStyle } from '../../appearance/native-chat-appearance-style'
import { useAppStore } from '@/store'

function workspaceFixture({
  branch = 'master',
  width = 640,
  hostId = 'local',
  folder = false,
  projectName = 'orca',
  checkout = 'orca',
  folderName = 'notes',
  machineName = '',
  fontSize
}: {
  branch?: string
  width?: number
  hostId?: 'local' | `runtime:${string}` | `ssh:${string}`
  folder?: boolean
  projectName?: string
  checkout?: string
  folderName?: string
  machineName?: string
  fontSize?: number
} = {}) {
  const repo: Repo = {
    id: 'composer-preview',
    path: '/preview/orca',
    displayName: projectName,
    badgeColor: '',
    addedAt: 1,
    kind: folder ? 'folder' : 'git',
    executionHostId: hostId
  }
  const workspace: Worktree = {
    id: `${repo.id}::${repo.path}`,
    repoId: repo.id,
    hostId,
    instanceId: 'composer-preview-instance',
    path: repo.path,
    displayName: folder ? folderName : checkout,
    branch: folder ? '' : branch,
    head: folder ? '' : 'a1b2c3d4e5f6',
    isBare: false,
    isMainWorktree: true,
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
  return defineFixture({
    width,
    store: {
      repos: [repo],
      worktreesByRepo: { [repo.id]: [workspace] },
      unifiedTabsByWorktree: {
        [workspace.id]: [
          {
            id: 'composer-preview-tab',
            entityId: 'composer-preview-session',
            contentType: 'agent-session',
            agentSessionAgent: 'codex',
            worktreeId: workspace.id,
            groupId: 'preview',
            executionHostId: hostId,
            label: 'Chat',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      }
    },
    setup: () => {
      useAppStore.setState((state) => ({
        settings: { ...getDefaultSettings('/home/fixture'), ...state.settings, machineName }
      }))
    },
    render: () => (
      <div
        className="native-chat-appearance bg-background py-3"
        style={
          fontSize ? nativeChatAppearanceStyle({ nativeChatAppearance: { fontSize } }) : undefined
        }
      >
        <NativeChatComposerWorkspace terminalTabId="composer-preview-tab" />
      </div>
    ),
    interact: (frame) => {
      if (machineName) {
        const machine = frame.querySelector<HTMLElement>(`[title="${machineName}"]`)
        if (!machine || machine.getBoundingClientRect().width === 0) {
          throw new Error('The large-text case must include the visible machine context')
        }
      }
      if (folder) {
        const folderButton = frame.querySelector<HTMLButtonElement>(
          `[aria-label="Copy ${folderName}"]`
        )
        if (!folderButton) {
          throw new Error('The folder chip must be present')
        }
        // The folder icon already names the kind, so the chip shows only the name.
        if (folderButton.textContent !== folderName) {
          throw new Error('The folder chip must show only the folder name, with no kind suffix')
        }
        const name = folderButton.querySelector('span')
        const row = folderButton.closest<HTMLElement>('[class~="@container"]')
        if (
          !name ||
          !row ||
          folderButton.getBoundingClientRect().right > row.getBoundingClientRect().right + 1
        ) {
          throw new Error('The folder chip must fit inside the composer footer')
        }
        if (folderName.length > 40 && name.scrollWidth <= name.clientWidth) {
          throw new Error('A long folder name must truncate in a narrow composer')
        }
        return
      }
      if (projectName !== checkout) {
        const project = frame.querySelector<HTMLElement>('[data-chat-footer-project]')
        if (!project || project.getBoundingClientRect().width === 0) {
          throw new Error('The project name must be visible in the composer footer')
        }
      } else if (!folder && width >= 384) {
        const checkoutButton = frame.querySelector<HTMLElement>(`[aria-label="Copy ${checkout}"]`)
        if (!checkoutButton || checkoutButton.getBoundingClientRect().width === 0) {
          throw new Error('A matching project and checkout must keep the checkout visible')
        }
      }
      const button =
        frame.querySelector<HTMLButtonElement>('[aria-label^="Switch branch:"]') ??
        Array.from(frame.querySelectorAll<HTMLButtonElement>('button')).at(-1)
      if (!button) {
        throw new Error('The workspace identity control must be present')
      }
      if (button) {
        const expectedAction = !branch
          ? 'Copy Commit a1b2c3d (not a branch)'
          : hostId.startsWith('ssh:')
            ? `Copy ${branch}`
            : `Switch branch: ${branch}`
        if (button.getAttribute('aria-label') !== expectedAction) {
          throw new Error('The identity control must retain its switch or copy action')
        }
        const label = button.querySelector('span')
        const icon = button.querySelector('svg')
        const row = button.closest<HTMLElement>('[class~="@container"]')
        if (
          !label ||
          !row ||
          button.getBoundingClientRect().right > row.getBoundingClientRect().right + 1
        ) {
          throw new Error('The branch control must fit inside the composer footer')
        }
        if (
          (branch === 'master' || !branch) &&
          button.getBoundingClientRect().right - label.getBoundingClientRect().right > 16
        ) {
          throw new Error('The branch hover target must end beside its short label')
        }
        if (width === 260 && label.scrollWidth <= label.clientWidth) {
          throw new Error('A long branch name must truncate in a narrow composer')
        }
        if (
          !icon ||
          icon.getBoundingClientRect().width === 0 ||
          icon.getBoundingClientRect().left < button.getBoundingClientRect().left ||
          icon.getBoundingClientRect().right > button.getBoundingClientRect().right
        ) {
          throw new Error('The branch control must have room for its icon')
        }
        const checkoutButton = frame.querySelector<HTMLButtonElement>(
          `[aria-label="Copy ${checkout}"]`
        )
        const checkoutKind = checkoutButton?.querySelector<HTMLElement>('[data-chat-footer-kind]')
        if (
          checkoutButton &&
          checkoutKind &&
          checkoutButton.getBoundingClientRect().width > 0 &&
          checkoutKind.getBoundingClientRect().right > button.getBoundingClientRect().left
        ) {
          throw new Error('The checkout label must not overlap the branch control')
        }
        if (
          checkoutKind &&
          checkoutKind.getBoundingClientRect().width > 0 &&
          checkoutKind.scrollWidth > checkoutKind.clientWidth + 1
        ) {
          throw new Error('The checkout name must truncate before its ordinary kind label')
        }
        // Freeze the primitive's hover colours for a deterministic hover preview.
        button.style.backgroundColor = frame.closest('.dark')
          ? 'color-mix(in srgb, var(--accent) 50%, transparent)'
          : 'var(--accent)'
        button.style.color = 'var(--accent-foreground)'
      }
    }
  })
}

export const shortBranch = workspaceFixture()
export const sameProjectAndCheckout = workspaceFixture({ width: 440 })
export const projectAndWorktree = workspaceFixture({
  projectName: 'orca',
  checkout: 'feature-worktree'
})
export const longProjectAndWorktree = workspaceFixture({
  projectName: 'orca-desktop-platform-services',
  checkout: 'feature-keep-the-composer-branch-button-within-a-narrow-pane',
  width: 440
})
export const longBranch = workspaceFixture({
  branch: 'feature/keep-the-composer-branch-button-within-a-narrow-pane'
})
export const narrowBranch = workspaceFixture({
  branch: 'feature/keep-the-composer-branch-button-within-a-narrow-pane',
  width: 260
})
export const constrainedLongBranch = workspaceFixture({
  branch:
    'feature/keep-the-composer-branch-button-within-a-narrow-pane-and-preserve-the-workspace-label',
  width: 440
})
export const largeTextContext = workspaceFixture({
  width: 584,
  fontSize: 20,
  checkout: 'workspace-with-a-long-checkout-name',
  machineName: 'Brennans-development-machine-with-a-long-name'
})
export const longCheckout = workspaceFixture({
  checkout: 'feature-keep-the-composer-branch-button-within-a-narrow-pane'
})
export const largeTextLongBranch = workspaceFixture({
  width: 584,
  fontSize: 20,
  branch: 'feature/keep-the-composer-branch-button-within-a-narrow-pane',
  checkout: 'workspace-with-a-long-checkout-name',
  machineName: 'Brennans-development-machine-with-a-long-name'
})
export const remoteBranch = workspaceFixture({ hostId: 'runtime:preview-server' })
export const sshBranch = workspaceFixture({ hostId: 'ssh:preview-server' })
export const detachedCommit = workspaceFixture({ branch: '' })
export const folderWorkspace = workspaceFixture({ folder: true, width: 320 })
export const narrowLongFolder = workspaceFixture({
  folder: true,
  width: 260,
  folderName: 'quarterly-planning-notes-and-research-for-the-design-team'
})
