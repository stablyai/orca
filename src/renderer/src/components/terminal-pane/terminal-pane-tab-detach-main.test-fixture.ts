// A drag-out in a layout-owner build, end to end: a real store, main's model answering the
// window's `movePaneToNewTab` through the layout transport, and main's frame drawing the result.
// The importing test file installs the transport mocks (see layout-apply-test-transport).

import { expect, vi } from 'vitest'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import { loadMainLayoutModel } from '@/runtime/main-loaded-layout-frames.test-fixture'
import { openWorkspaceLayoutFrameSync } from '@/runtime/workspace-layout-frame-sync'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import {
  createTestStore,
  makeWorktree,
  seedStore,
  TEST_REPO
} from '../../store/slices/store-test-helpers'
import { detachTerminalPaneToTab } from './terminal-pane-tab-detach'
import { LEAF_1, LEAF_2 } from './terminal-pane-tab-detach-fixture'

export const WT = 'repo1::/path/wt'
export const SOURCE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
export const OTHER_1 = 'cccccccc-dddd-4eee-8fff-000000000001'
export const OTHER_2 = 'cccccccc-dddd-4eee-8fff-000000000002'
export const GROUP = 'group-1'

export type DetachStore = ReturnType<typeof createTestStore>

function row(id: string, ptyId: string | null, createdAt: number, shellOverride?: string) {
  return {
    id,
    ptyId,
    worktreeId: WT,
    title: `Terminal ${createdAt}`,
    defaultTitle: `Terminal ${createdAt}`,
    customTitle: null,
    color: null,
    sortOrder: createdAt,
    createdAt,
    ...(shellOverride ? { shellOverride } : {})
  }
}

function entry(id: string, createdAt: number, viewMode?: 'chat') {
  return {
    id,
    entityId: id,
    groupId: GROUP,
    worktreeId: WT,
    contentType: 'terminal' as const,
    label: `Terminal ${createdAt}`,
    customLabel: null,
    color: null,
    sortOrder: createdAt,
    createdAt,
    ...(viewMode ? { viewMode } : {})
  }
}

function soloLayout(leafId: string, ptyId: string): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId },
    activeLeafId: leafId,
    expandedLeafId: null,
    ptyIdsByLeafId: { [leafId]: ptyId }
  }
}

/** The source tab with `layout`, after two other tabs in its group: [OTHER_1, OTHER_2, SOURCE]. */
export function seedDetachStore(
  layout: TerminalLayoutSnapshot,
  /** `sshRepo`: the window keeps the pane's scrollback, as for any SSH terminal. */
  options: { shellOverride?: string; sshRepo?: true } = {}
): DetachStore {
  const store = createTestStore()
  const sourcePty = layout.ptyIdsByLeafId?.[LEAF_1] ?? null
  seedStore(store, {
    ...(options.sshRepo ? { repos: [{ ...TEST_REPO, connectionId: 'ssh-1' }] } : {}),
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt' })] },
    tabsByWorktree: {
      [WT]: [
        row(OTHER_1, 'pty-other-1', 1),
        row(OTHER_2, 'pty-other-2', 2),
        row(SOURCE, sourcePty, 3, options.shellOverride)
      ]
    },
    unifiedTabsByWorktree: {
      [WT]: [
        entry(OTHER_1, 1),
        entry(OTHER_2, 2),
        entry(SOURCE, 3, layout.chatLeafId ? 'chat' : undefined)
      ]
    },
    groupsByWorktree: {
      [WT]: [
        {
          id: GROUP,
          worktreeId: WT,
          activeTabId: SOURCE,
          tabOrder: [OTHER_1, OTHER_2, SOURCE],
          recentTabIds: [SOURCE]
        }
      ]
    },
    activeGroupIdByWorktree: { [WT]: GROUP },
    activeTabIdByWorktree: { [WT]: SOURCE },
    terminalLayoutsByTabId: {
      [OTHER_1]: soloLayout('aaaaaaaa-1111-4111-8111-111111111111', 'pty-other-1'),
      [OTHER_2]: soloLayout('bbbbbbbb-2222-4222-8222-222222222222', 'pty-other-2'),
      [SOURCE]: layout
    }
  })
  return store
}

/** Main loads the store's session as its model, and the window draws main's frames from now on. */
export async function openMainFrames(store: DetachStore): Promise<() => void> {
  layoutApplyTestTransport.reset()
  layoutApplyTestTransport.answerWith('apply')
  layoutApplyTestTransport.useMainModel(
    loadMainLayoutModel('local', buildWorkspaceSessionPayload(store.getState()))
  )
  const frames = openWorkspaceLayoutFrameSync(store)
  frames.start()
  await vi.waitFor(() => expect(store.getState().tabsByWorktree[WT]).toBeDefined())
  return () => frames.close()
}

export type DetachArgs = Partial<Parameters<typeof detachTerminalPaneToTab>[0]>

/** The pane manager of a two-pane source tab: pane 1 is LEAF_1, pane 2 is LEAF_2. */
export function twoPaneManager() {
  return {
    getPanes: vi.fn(() => [{ id: 1 }, { id: 2 }]),
    getLeafId: vi.fn((paneId: number): string | null => (paneId === 2 ? LEAF_2 : LEAF_1)),
    detachPaneForExternalMove: vi.fn(() => true)
  }
}

export function detachFrom(store: DetachStore, args: DetachArgs = {}) {
  return detachTerminalPaneToTab({
    getStore: () => store.getState(),
    manager: twoPaneManager(),
    persistLayoutSnapshot: vi.fn(),
    sourcePaneId: 2,
    sourceTabId: SOURCE,
    targetGroupId: GROUP,
    worktreeId: WT,
    ...args
  })
}

/** The one `movePaneToNewTab` the window sent main. */
export function sentMove() {
  const sent = layoutApplyTestTransport.sentOfType('movePaneToNewTab')
  expect(sent).toHaveLength(1)
  return sent[0]!
}

/** The tab main minted for the move, as main's model holds it. */
export function mainMovedTabId(): string {
  const workspace = layoutApplyTestTransport.mainModel?.workspaces[WT]
  const ids = (workspace?.tabs ?? [])
    .map((tab) => tab.id)
    .filter((id) => ![SOURCE, OTHER_1, OTHER_2].includes(id))
  expect(ids).toHaveLength(1)
  return ids[0]!
}
