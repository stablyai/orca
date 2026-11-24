import { DndContext } from '@dnd-kit/core'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { stubBots } from '../../../component-fixtures/fixture-bots'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { ConfirmationDialogProvider } from '../../dismiss/confirmation/confirmation-dialog'
import type { Bot } from '../../../../../shared/bot-types'
import { folderWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import TabBar from '../TabBar'

// A bot's home: the + menu searches the bot's chats where other workspaces search agents.
const bot: Bot = {
  id: 'release-helper',
  name: 'Release helper',
  hostId: 'local',
  folder: 'release-helper',
  folderWorkspaceId: 'fw-release-helper',
  agent: 'claude',
  avatar: null,
  paused: false,
  notifications: {
    needsPermission: true,
    taskComplete: true,
    couldNotFinish: true
  },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: 'release-helper-chat',
  createdAt: 0,
  updatedAt: 0
}
const WORKSPACE_ID = folderWorkspaceKey(bot.folderWorkspaceId)
const GROUP_ID = 'bot-home-group'

const AGENTS = ['claude', 'codex'] as const

const noop = (): void => {}
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 250))

// The bot RPCs the fixture's runtime received, so a case can check what Enter started.
const sentRpcs: { method: string; params: unknown }[] = []

function recordBotRpcs(): void {
  stubBots([bot])
  const runtime = window.api.runtime as {
    call: (args: { method: string }) => Promise<unknown>
  }
  const answer = runtime.call
  Reflect.set(window.api, 'runtime', {
    ...runtime,
    call: async (args: { method: string; params?: unknown }) => {
      sentRpcs.push({ method: args.method, params: args.params })
      return args.method === 'bots.session.start'
        ? { ok: true, result: { sessionId: 'side-chat' } }
        : answer(args)
    }
  })
}

function resultLabels(): string[] {
  return [...document.querySelectorAll('[role="listbox"] [role="option"]')].map(
    (row) => row.textContent ?? ''
  )
}

function expect(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`${message}; results: ${JSON.stringify(resultLabels())}`)
  }
}

async function openMenuAndSearch(frame: HTMLElement, query: string): Promise<void> {
  const trigger = frame.querySelector<HTMLButtonElement>(
    '[data-contextual-tour-target="tab-create-menu"]'
  )
  trigger?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
  trigger?.click()
  await settle()
  const input = document.querySelector<HTMLInputElement>('input[role="combobox"]')
  if (input && query) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, query)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  await settle()
}

function searchCase(query: string, check: (frame: HTMLElement) => void | Promise<void>) {
  return defineFixture({
    width: 420,
    store: {
      activeWorktreeId: WORKSPACE_ID,
      activeGroupIdByWorktree: { [WORKSPACE_ID]: GROUP_ID },
      folderWorkspaces: [
        makeFolderWorkspace({
          id: bot.folderWorkspaceId,
          projectGroupId: 'bots',
          name: bot.name,
          folderPath: `/home/me/.orca/bots/${bot.folder}`
        })
      ],
      detectedAgentIds: [...AGENTS],
      localDetectedAgentIdsByContext: {
        host: [...AGENTS],
        'host\u0000all-agents': [...AGENTS]
      },
      ensureDetectedAgents: async () => [...AGENTS]
    },
    setup: recordBotRpcs,
    render: () => (
      <ConfirmationDialogProvider>
        <DndContext>
          <div className="@container/tab-strip h-[420px] bg-card">
            <div className="h-8">
              <TabBar
                tabs={[]}
                activeTabId={null}
                activeTabType="terminal"
                worktreeId={WORKSPACE_ID}
                groupId={GROUP_ID}
                groupActiveTabId={null}
                expandedPaneByTabId={{}}
                showAgentLaunchItems
                onActivate={noop}
                onClose={noop}
                onCloseOthers={noop}
                onCloseToRight={noop}
                onCloseToLeft={noop}
                onNewTerminalTab={noop}
                onNewBrowserTab={noop}
                onOpenEntry={async () => {}}
                onSetCustomTitle={noop}
                onSetTabColor={noop}
                onTogglePaneExpand={noop}
              />
            </div>
          </div>
        </DndContext>
      </ConfirmationDialogProvider>
    ),
    interact: async (frame) => {
      await openMenuAndSearch(frame, query)
      await check(frame)
    }
  })
}

/** No query: New Home Chat and the side chats, as a list. */
export const noQuery = searchCase('', () => {
  const items = [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)
  expect(
    items.some((text) => text?.includes('New Home Chat')) &&
      items.some((text) => text?.includes('New Codex Chat')),
    "An empty search lists the bot's chats"
  )
})

/** "codex": the Codex side chat leads, ahead of file and web rows, no other chat shows, and Enter
 *  starts that side chat with the bot. */
export const codex = searchCase('codex', async () => {
  const labels = resultLabels()
  expect(labels[0]?.startsWith('New Codex Chat') ?? false, 'The Codex side chat ranks first')
  expect(
    !labels.some((text) => /New (Home|Claude Code) Chat/.test(text)),
    'No other chat matches "codex"'
  )
  expect(
    document.querySelectorAll('[role="menuitem"]').length === 0 ||
      ![...document.querySelectorAll('[role="menuitem"]')].some((item) =>
        item.textContent?.includes('Chat')
      ),
    'The unfiltered chat list hides while searching'
  )
  const input = document.querySelector<HTMLInputElement>('input[role="combobox"]')
  input?.form?.requestSubmit()
  await settle()
  const start = sentRpcs.find((rpc) => rpc.method === 'bots.session.start')
  expect(
    JSON.stringify(start?.params ?? null).includes('"codex"'),
    `Enter starts a Codex side chat (sent ${JSON.stringify(sentRpcs.map((rpc) => rpc.method))})`
  )
})

/** "home": only New Home Chat. */
export const home = searchCase('home', () => {
  const chats = resultLabels().filter((text) => text.includes('Chat'))
  expect(chats.length === 1 && chats[0]!.startsWith('New Home Chat'), 'Only New Home Chat matches')
})

/** A word no chat has: no chat rows at all. */
export const noChatMatch = searchCase('readme', () => {
  expect(!resultLabels().some((text) => text.includes(' Chat')), 'No chat matches "readme"')
})
