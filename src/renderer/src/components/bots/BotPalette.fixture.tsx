import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import { useLayoutEffect, useRef } from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import {
  publishBots,
  setBotHostListing,
  stampBotHost,
  type BotHostListing
} from '@/lib/bot-catalog-snapshot'
import { refreshBotPurposes } from './use-bot-purposes'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { useAppStore } from '@/store'
import type { Bot } from '../../../../shared/bot-types'
import WorktreeJumpPalette from '../worktree-jump/WorktreeJumpPalette'
import { registerNativeChatComposerReclaim } from '../native-chat/composer/focus/native-chat-composer-focus-intent'
import { publishBotGroups } from '@/lib/bot-group-catalog-snapshot'
import { stubBots } from '../../component-fixtures/fixture-bots'
import { SidebarBotsSection } from './SidebarBotsSection'
import { ConfirmationDialogProvider } from '../dismiss/confirmation/confirmation-dialog'
import { makeAgentEntry } from '../worktree-jump/worktree-jump-palette-test-fixtures'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/rpc/testing/runtime-compatibility-test-fixture'
import { chatPaneKey } from '../../../../shared/agent-session/view/structured-agent-session-projection'

const OFFLINE_HOST = 'runtime:palette-preview'
const waitingBot: Bot = {
  id: 'waiting',
  name: 'Support triage',
  hostId: 'local',
  folder: 'waiting',
  folderWorkspaceId: 'fw-waiting',
  agent: 'claude',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: 'palette-waiting-chat',
  createdAt: Date.now(),
  updatedAt: Date.now()
}
const offlineBot = stampBotHost(OFFLINE_HOST, {
  ...waitingBot,
  id: 'offline',
  name: 'Release reviewer',
  folder: 'offline',
  folderWorkspaceId: 'fw-offline',
  paused: true
})
const bothLive: BotHostListing = {
  hosts: [
    { hostId: 'local' as const, state: 'live' as const },
    { hostId: OFFLINE_HOST, state: 'live' as const }
  ],
  updateNeeded: []
}
const approval = makeAgentEntry('palette-waiting-chat', 'waiting', Date.now(), {
  paneKey: chatPaneKey('palette-waiting-chat'),
  worktreeId: 'folder:fw-waiting',
  agentType: 'claude',
  lastAssistantMessage: 'Waiting for approval'
})

function purposeCase(statuses: boolean) {
  return defineFixture({
    width: 900,
    store: {
      activeModal: 'worktree-palette',
      agentStatusByPaneKey: acceptedAgentStatuses(statuses ? [[approval.paneKey, approval]] : []),
      folderWorkspaces: (statuses ? [waitingBot, offlineBot] : [waitingBot]).map((bot) =>
        makeFolderWorkspace({
          id: bot.folderWorkspaceId,
          name: bot.name,
          executionHostId: bot.hostId,
          folderPath: `/preview/${bot.folder}`
        })
      )
    },
    setup: () => {
      publishBotGroups([])
      setBotHostListing(statuses ? bothLive : { hosts: [bothLive.hosts[0]], updateNeeded: [] })
      publishBots([waitingBot], {
        threadReplies: false,
        webhooks: false,
        waits: statuses ? { waiting: [{ label: 'approval' }] } : {}
      })
      if (statuses) {
        publishBots([offlineBot], { threadReplies: false, webhooks: false }, OFFLINE_HOST)
      }
      const answer = (hostId: string, method: string) => {
        if (method === 'status.get') {
          return createCompatibleRuntimeStatusResponse(hostId)
        }
        const bot = hostId === 'local' ? waitingBot : offlineBot
        const results: Record<string, unknown> = {
          'bots.list': {
            bots: [bot],
            waits: statuses && hostId === 'local' ? { waiting: [{ label: 'approval' }] } : {}
          },
          'bots.groups.list': { groups: [] },
          'bots.chatTree': { chats: [], workspaceChats: {} },
          'bots.upNext.unseen': { unseen: {} },
          'bots.roster': {
            bots: [{ id: bot.id, name: bot.name, specialty: 'Handles WeChat support threads' }]
          }
        }
        return method in results
          ? { ok: true, result: results[method] }
          : { ok: false, error: { code: 'runtime_unavailable', message: method } }
      }
      Reflect.set(window.api, 'runtime', {
        ...window.api.runtime,
        call: async ({ method }: { method: string }) => answer('local', method)
      })
      Reflect.set(window.api, 'runtimeEnvironments', {
        ...window.api.runtimeEnvironments,
        call: async ({ method }: { method: string }) => answer(OFFLINE_HOST, method)
      })
      useAppStore.setState({ fetchFolderWorkspaces: async () => {} })
    },
    render: () => <WorktreeJumpPalette />,
    interact: async (frame) => {
      const doc = frame.ownerDocument
      for (let attempt = 0; attempt < 60 && !doc.querySelector('[cmdk-input]'); attempt += 1) {
        await new Promise((resolve) => requestAnimationFrame(resolve))
      }
      const input = doc.querySelector<HTMLInputElement>('[cmdk-input]')!
      await refreshBotPurposes()
      if (statuses) {
        setBotHostListing({
          ...bothLive,
          hosts: [bothLive.hosts[0], { hostId: OFFLINE_HOST, state: 'offline' }]
        })
      }
      input.dispatchEvent(
        new InputEvent('beforeinput', {
          inputType: 'insertText',
          data: '@',
          bubbles: true,
          cancelable: true
        })
      )
      await new Promise((resolve) => requestAnimationFrame(resolve))
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'wechat'
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((resolve) => requestAnimationFrame(resolve))
    }
  })
}

export const purposeStatusPriority = purposeCase(true)
export const purposeOnly = purposeCase(false)

const ROOM_TAB = 'palette-council-room'
const ROOM_WORKSPACE = 'folder:fw-council'
const council = {
  id: 'palette-council',
  name: 'Council',
  hostId: 'local' as const,
  revision: 1,
  folder: 'council',
  folderWorkspaceId: 'fw-council',
  createdAt: Date.now(),
  sidebarOrder: 99,
  members: [],
  replyMode: { kind: 'mentions' as const }
}
const sidebarBots = Array.from({ length: 24 }, (_, index) => ({
  ...waitingBot,
  id: `assistant-${index}`,
  name: `Assistant ${String(index + 1).padStart(2, '0')}`,
  folder: `assistant-${index}`,
  folderWorkspaceId: `fw-assistant-${index}`,
  sidebarOrder: index,
  paused: true
}))

function PreviewRoom(): React.JSX.Element {
  const input = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const composer = input.current
    if (composer) {
      return registerNativeChatComposerReclaim(
        ROOM_TAB,
        () => composer.focus(),
        composer.parentElement
      )
    }
    return undefined
  }, [])
  return (
    <div data-room-overlay-tab-id={ROOM_TAB} className="flex flex-1 flex-col gap-3 p-4">
      <span className="text-sm font-medium">Council</span>
      <textarea
        ref={input}
        aria-label="Group message"
        className="rounded-md border border-input bg-background p-3 text-sm"
      />
    </div>
  )
}

export const groupReveal = defineFixture({
  width: 1000,
  store: {
    activeModal: 'worktree-palette',
    sidebarOpen: true,
    sidebarBody: 'workspaces',
    collapsedGroups: new Set(),
    botSidebarView: { sortBy: 'manual', hidePausedBots: false, hideSleepingWorkers: false },
    folderWorkspaces: [...sidebarBots, council].map((owner) =>
      makeFolderWorkspace({
        id: owner.folderWorkspaceId,
        name: owner.name,
        folderPath: `/preview/${owner.folder}`
      })
    )
  },
  setup: () => {
    setBotHostListing({ hosts: [{ hostId: 'local', state: 'live' }], updateNeeded: [] })
    stubBots(sidebarBots)
    publishBotGroups([council])
    const runtime = window.api.runtime
    Reflect.set(window.api, 'runtime', {
      ...runtime,
      call: async (request: Parameters<typeof runtime.call>[0]) =>
        request.method === 'bots.groups.list'
          ? { ok: true, result: { groups: [council] } }
          : runtime.call(request)
    })
    useAppStore.setState({ fetchFolderWorkspaces: async () => {} })
    useAppStore.getState().createUnifiedTab(ROOM_WORKSPACE, 'room', {
      id: ROOM_TAB,
      entityId: council.id,
      executionHostId: 'local',
      label: council.name
    })
    useAppStore.setState({ activeTabIdByWorktree: {} })
  },
  render: () => (
    <ConfirmationDialogProvider>
      <div className="flex h-[400px] bg-background text-foreground">
        <div className="flex w-[280px] shrink-0 flex-col bg-worktree-sidebar text-worktree-sidebar-foreground">
          <SidebarBotsSection onOpenBot={() => {}} />
        </div>
        <PreviewRoom />
        <WorktreeJumpPalette />
      </div>
    </ConfirmationDialogProvider>
  )
})

export const groupRevealFolded = defineFixture({
  ...groupReveal,
  store: { ...groupReveal.store, collapsedGroups: new Set(['bots']) }
})
