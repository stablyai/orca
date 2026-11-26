import { defineFixture } from '../../component-fixtures/component-fixture'
import { useAppStore } from '@/store'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { AppState } from '@/store/types'
import WorktreeJumpPalette from './WorktreeJumpPalette'
import {
  makeGroup,
  makeTerminalTab,
  makeUnifiedTab,
  makeWorktree
} from './worktree-jump-palette-test-fixtures'

// Synthetic data only: section order for typed queries that pit workspace names against tab matches.
const repo: Repo = {
  id: 'repo-1',
  path: '/repos/acme-orca',
  displayName: 'acme/orca',
  badgeColor: '#22c55e',
  addedAt: 0
}

const LONG_NAME = 'feature-centralized-notification-delivery-pipeline-v2-long-name'

const workspaces = [
  ['wt-cn', 'centralized-notification', ''],
  ['wt-alpha', 'Alpha workspace', ''],
  ['wt-roadmap', 'roadmap-planning', ''],
  ['wt-billing', 'billing-cleanup', 'Draft design docs for invoices'],
  ['wt-long', LONG_NAME, '']
].map(([id, name, comment]) =>
  makeWorktree(id, name, {
    path: `/work/${name.toLowerCase().replaceAll(' ', '-')}`,
    branch: `refs/heads/demo/${name.toLowerCase().replaceAll(' ', '-')}`,
    comment
  })
)

function editorFile(id: string, worktreeId: string, root: string, relativePath: string): OpenFile {
  return {
    id,
    filePath: `${root}/${relativePath}`,
    relativePath,
    worktreeId,
    language: 'typescript',
    isDirty: false,
    mode: 'edit'
  }
}

const openFiles = [
  editorFile('file-app', 'wt-cn', '/work/centralized-notification', 'src/app.ts'),
  editorFile('file-rollout', 'wt-cn', '/work/centralized-notification', 'docs/rollout-plan.md'),
  editorFile(
    'file-long',
    'wt-long',
    `/work/${LONG_NAME}`,
    'src/notifications/delivery/pipeline/centralized-notification-delivery-coordinator.ts'
  )
]

function editorTab(id: string, worktreeId: string, fileId: string): Tab {
  return { ...makeUnifiedTab(id, worktreeId, fileId, fileId), contentType: 'editor' }
}

function chatTab(id: string, worktreeId: string, label: string): Tab {
  return {
    ...makeUnifiedTab(id, worktreeId, `chat-${id}`, label),
    contentType: 'agent-session',
    agentSessionAgent: 'claude'
  }
}

const terminals: [tabId: string, worktreeId: string, title: string][] = [
  ['term-cn', 'wt-cn', 'dev server'],
  ['term-alpha', 'wt-alpha', 'Alpha chat'],
  ['term-roadmap', 'wt-roadmap', 'roadmap'],
  ['term-design', 'wt-billing', 'Notification center design doc']
]

const tabsByWorkspace: Record<string, Tab[]> = {
  'wt-cn': [
    editorTab('tab-app', 'wt-cn', 'file-app'),
    editorTab('tab-rollout', 'wt-cn', 'file-rollout'),
    makeUnifiedTab('tab-term-cn', 'wt-cn', 'term-cn', 'dev server'),
    chatTab('tab-chat-cn', 'wt-cn', 'Review chat')
  ],
  'wt-long': [editorTab('tab-long', 'wt-long', 'file-long')]
}
for (const [tabId, worktreeId, title] of terminals) {
  if (worktreeId !== 'wt-cn') {
    tabsByWorkspace[worktreeId] = [makeUnifiedTab(`tab-${tabId}`, worktreeId, tabId, title)]
  }
}

const store: Partial<AppState> = {
  activeModal: 'worktree-palette',
  repos: [repo],
  worktreesByRepo: { 'repo-1': workspaces },
  showSleepingWorkspaces: true,
  openFiles,
  ptyIdsByTabId: Object.fromEntries(terminals.map(([tabId]) => [tabId, [`pty-${tabId}`]])),
  tabsByWorktree: Object.fromEntries(
    workspaces.map((workspace) => [
      workspace.id,
      terminals
        .filter(([, worktreeId]) => worktreeId === workspace.id)
        .map(([tabId, worktreeId, title]) => makeTerminalTab(tabId, worktreeId, title))
    ])
  ),
  unifiedTabsByWorktree: tabsByWorkspace,
  groupsByWorktree: Object.fromEntries(
    Object.entries(tabsByWorkspace).map(([worktreeId, tabs]) => [
      worktreeId,
      [
        makeGroup(
          worktreeId,
          tabs.map((tab) => tab.id)
        )
      ]
    ])
  ),
  activeGroupIdByWorktree: Object.fromEntries(
    Object.keys(tabsByWorkspace).map((worktreeId) => [worktreeId, `group-${worktreeId}`])
  )
}

function paletteCase(query: string) {
  return defineFixture({
    width: 900,
    store,
    setup: () => {
      // Expose the activated workspace so keyboard Enter can be checked from outside the page.
      useAppStore.subscribe((state) => {
        document.documentElement.dataset.fixtureActiveWorktree = state.activeWorktreeId ?? ''
      })
    },
    render: () => <WorktreeJumpPalette />,
    interact: async (frame) => {
      const doc = frame.ownerDocument
      for (let attempt = 0; attempt < 60 && !doc.querySelector('[cmdk-input]'); attempt += 1) {
        await new Promise((resolve) => requestAnimationFrame(resolve))
      }
      const input = doc.querySelector<HTMLInputElement>('[cmdk-input]')
      if (!input || !query) {
        return
      }
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, query)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      for (let frameCount = 0; frameCount < 4; frameCount += 1) {
        await new Promise((resolve) => requestAnimationFrame(resolve))
      }
    }
  })
}

export const centralized = paletteCase('centralized')
export const alpha = paletteCase('alpha')
export const designDoc = paletteCase('design doc')
export const exactTabTitle = paletteCase('roadmap')
export const fullPathPaste = paletteCase('/work/centralized-notification/src/app.ts')
export const empty = paletteCase('')
