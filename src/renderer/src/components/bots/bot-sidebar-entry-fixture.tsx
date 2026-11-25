// The Bots section with one bot and a seeded chats read, for the sidebar fixtures.
import { defineFixture } from '../../component-fixtures/component-fixture'
import { stubBots } from '../../component-fixtures/fixture-bots'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import type { Bot } from '../../../../shared/bot-types'
import { mascotAvatar } from '../../../../shared/bot-avatar'
import {
  botChatFoldKey,
  type BotChatTreeChat,
  type BotChatTreeRead,
  type BotChatTreeWorker
} from '../../../../shared/bots/bot-chat-tree'
import {
  folderWorkspaceKey,
  worktreeWorkspaceKey
} from '../../../../shared/workspace/identity/workspace-scope'
import { ConfirmationDialogProvider } from '../dismiss/confirmation/confirmation-dialog'
import { SidebarBotsSection } from './SidebarBotsSection'
import { getLineageGroupKey } from '../../../../shared/sidebar-list/sections/group-keys'

export const NOW = Date.now()
export const HOUR = 3_600_000

const BOT: Bot = {
  id: 'builder',
  name: 'Bot builder',
  hostId: 'local',
  folder: 'builder',
  folderWorkspaceId: 'fw-builder',
  agent: 'claude',
  avatar: mascotAvatar('F1'),
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: 'home',
  sidebarOrder: 0,
  createdAt: 1,
  updatedAt: 1
}

export const worker = (
  name: string,
  state: BotChatTreeWorker['state'],
  note?: BotChatTreeWorker['note']
): BotChatTreeWorker => ({
  key: name,
  title: name,
  state,
  startedAt: NOW - HOUR,
  worktreeId: `repo-1::/${name}`,
  ...(note ? { note } : {})
})

export function chat(
  chatId: string,
  title: string,
  origin: BotChatTreeChat['origin'],
  workers: { running?: BotChatTreeWorker[]; finished?: BotChatTreeWorker[] },
  extra: Partial<BotChatTreeChat> = {}
): BotChatTreeChat {
  const running = workers.running ?? []
  const finished = workers.finished ?? []
  return {
    chatId,
    title,
    origin,
    live: 'idle',
    lastActiveAt: NOW - HOUR,
    unread: false,
    closed: false,
    tab: false,
    running,
    runningTotal: running.length,
    finished,
    finishedTotal: finished.length,
    failedTotal: 0,
    ...extra
  }
}

function treeOf(chats: BotChatTreeChat[]): BotChatTreeRead {
  const workspaceChats: Record<string, string> = {}
  for (const entry of chats) {
    for (const each of [...entry.running, ...entry.finished]) {
      workspaceChats[each.worktreeId!] = entry.chatId
    }
  }
  return { chats, workspaceChats }
}

export function fixtureFor(
  chats: BotChatTreeChat[],
  folds: Record<string, 'open' | 'folded'> = {},
  botFolded = false,
  /** One worker, selected, with this many child workspaces of its own. */
  selected?: { worker: string; children: number }
) {
  const tree = treeOf(chats)
  const line = (id: string) => {
    const name = id.slice('repo-1::/'.length)
    return makeWorktree({
      id,
      instanceId: `${name}-instance`,
      repoId: 'repo-1',
      path: `/${name}`,
      displayName: name
    })
  }
  const lines = Object.keys(tree.workspaceChats).map(line)
  const selectedId = selected ? `repo-1::/${selected.worker}` : null
  const children = selected
    ? Array.from({ length: selected.children }, (_, index) =>
        line(`repo-1::/${selected.worker}-child-${index}`)
      )
    : []
  const worktrees = [...lines, ...children]
  return defineFixture({
    width: 260,
    store: {
      folderWorkspaces: [
        makeFolderWorkspace({
          id: BOT.folderWorkspaceId,
          projectGroupId: 'bots',
          name: BOT.name,
          folderPath: '/home/me/.orca/bots/builder'
        })
      ],
      worktreesByRepo: { 'repo-1': worktrees },
      workspaceLineageByChildKey: Object.fromEntries(
        lines.map((worktree) => [
          worktreeWorkspaceKey(worktree.id),
          {
            childWorkspaceKey: worktreeWorkspaceKey(worktree.id),
            parentWorkspaceKey: folderWorkspaceKey(BOT.folderWorkspaceId),
            origin: 'orchestration' as const,
            capture: { source: 'orchestration-context' as const, confidence: 'explicit' as const },
            createdAt: 1
          }
        ])
      ),
      worktreeLineageById: Object.fromEntries(
        children.map((child) => [
          child.id,
          {
            worktreeId: child.id,
            worktreeInstanceId: child.instanceId ?? '',
            parentWorktreeId: selectedId!,
            parentWorktreeInstanceId:
              lines.find((each) => each.id === selectedId)?.instanceId ?? '',
            origin: 'orchestration' as const,
            capture: { source: 'orchestration-context' as const, confidence: 'explicit' as const },
            createdAt: 1
          }
        ])
      ),
      ...(selectedId
        ? { activeWorktreeId: selectedId, activeWorkspaceKey: worktreeWorkspaceKey(selectedId) }
        : {}),
      ...(botFolded
        ? {
            collapsedGroups: new Set([
              getLineageGroupKey(folderWorkspaceKey(BOT.folderWorkspaceId))
            ])
          }
        : {}),
      botChatFolds: Object.fromEntries(
        Object.entries(folds).map(([chatId, fold]) => [
          botChatFoldKey('local', BOT.id, chatId),
          fold
        ])
      )
    },
    setup: () => {
      stubBots([BOT])
      const runtime = window.api.runtime
      const call = runtime.call.bind(runtime)
      Reflect.set(window.api, 'runtime', {
        ...runtime,
        call: async (request: { method: string }) =>
          request.method === 'bots.chatTree' ? { ok: true, result: tree } : call(request)
      })
    },
    render: () => (
      <ConfirmationDialogProvider>
        <div className="flex flex-col bg-sidebar py-2 text-sidebar-foreground">
          <SidebarBotsSection onOpenBot={() => {}} />
        </div>
      </ConfirmationDialogProvider>
    )
  })
}

// Waits for the chats read to land, then clicks the "Show more" link that starts with this text.
export async function clickText(frame: HTMLElement, text: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const button = [...frame.querySelectorAll('button')].find((each) =>
      each.textContent?.startsWith(text)
    )
    if (button) {
      button.click()
      await new Promise((resolve) => setTimeout(resolve, 100))
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`No "${text}" button`)
}
