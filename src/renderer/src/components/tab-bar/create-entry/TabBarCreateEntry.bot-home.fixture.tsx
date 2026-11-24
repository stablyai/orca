import { DndContext } from '@dnd-kit/core'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { stubBots } from '../../../component-fixtures/fixture-bots'
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
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
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

const noop = (): void => {}
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 250))

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

function searchCase(query: string) {
  return defineFixture({
    width: 420,
    store: {
      activeWorktreeId: WORKSPACE_ID,
      activeGroupIdByWorktree: { [WORKSPACE_ID]: GROUP_ID },
      localDetectedAgentIdsByContext: { host: ['claude', 'codex'] },
      ensureDetectedAgents: async () => ['claude', 'codex']
    },
    setup: () => stubBots([bot]),
    render: () => (
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
    ),
    interact: (frame) => openMenuAndSearch(frame, query)
  })
}

/** No query: New Home Chat and the side chats, as a list. */
export const noQuery = searchCase('')
/** "codex": the Codex side chat leads, ahead of file and web rows; no other chat shows. */
export const codex = searchCase('codex')
/** "home": only New Home Chat. */
export const home = searchCase('home')
/** A word no chat has: no chat rows at all. */
export const noChatMatch = searchCase('readme')
