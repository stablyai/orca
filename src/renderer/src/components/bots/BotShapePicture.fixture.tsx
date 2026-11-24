import { useState } from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { stubBots } from '../../component-fixtures/fixture-bots'
import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { structuredAgentSessionStatusPaneKey } from '../../../../shared/agent-session/view/structured-agent-session-tab'
import { BOT_SHAPE_AVATAR } from '../../../../shared/bot-avatar'
import type { Bot } from '../../../../shared/bot-types'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { ConfirmationDialogProvider } from '../dismiss/confirmation/confirmation-dialog'
import { useBotPictureSetting } from '../settings/bots/use-bot-picture-setting'
import { BotPictureButton } from './BotPictureButton'
import { BotRow } from './BotRow'

const now = Date.now()

function bot(id: string, name: string, fields: Partial<Bot> = {}): Bot {
  return {
    id,
    name,
    hostId: 'local',
    folder: id,
    folderWorkspaceId: `fw-${id}`,
    agent: 'claude',
    avatar: BOT_SHAPE_AVATAR,
    paused: false,
    notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
    members: [],
    slack: null,
    linear: null,
    github: null,
    chatSessionId: `chat-${id}`,
    createdAt: 1,
    updatedAt: 1,
    ...fields
  }
}

const mascot = bot('mascot', 'Mascot bot', { avatar: 'mascot:D1' })
const idle = bot('mug', 'Mug bot', { avatarColor: '#c9b8e8' })
const working = bot('mug-busy', 'Mug bot at work', { avatarColor: '#f8cfa8' })
const CASES: [string, Bot][] = [
  ['Mascot picture (unchanged)', mascot],
  ['Shape picture, idle: still', idle],
  ['Shape picture, working: live', working]
]

const paneKey = structuredAgentSessionStatusPaneKey('chat-mug-busy')

// The Bots sidebar rows: only a working shape bot animates; a mascot and an idle shape stay still.
export const rows = defineFixture({
  width: 300,
  store: {
    agentStatusByPaneKey: acceptedAgentStatuses([
      [
        paneKey,
        {
          paneKey,
          worktreeId: folderWorkspaceKey(working.folderWorkspaceId),
          agentType: 'claude',
          state: 'working',
          prompt: '',
          toolName: 'Read',
          toolInput: 'release notes',
          updatedAt: now - 10_000,
          stateStartedAt: now - 10_000,
          stateHistory: []
        }
      ]
    ])
  },
  setup: () => stubBots([mascot, idle, working]),
  render: () => (
    <ConfirmationDialogProvider>
      <div className="flex flex-col gap-2 bg-background p-3">
        {CASES.map(([label, owner]) => (
          <div key={owner.id} className="flex flex-col gap-1">
            <div className="text-[11px] text-muted-foreground">{label}</div>
            <div
              data-case={owner.id}
              className="flex flex-col rounded-lg border border-border bg-worktree-sidebar py-1 pr-1.5 text-worktree-sidebar-foreground"
            >
              <BotRow
                bot={owner}
                home={makeFolderWorkspace({
                  id: owner.folderWorkspaceId,
                  name: owner.name,
                  folderPath: `/bots/${owner.folder}`
                })}
                isActive={false}
                onOpen={() => {}}
              />
            </div>
          </div>
        ))}
      </div>
    </ConfirmationDialogProvider>
  )
})

// Settings > Picture for a bot wearing the shape: the color row stays, the outfits do not.
function ShapeSettings(): React.JSX.Element {
  const [shown, setShown] = useState(idle)
  const picture = useBotPictureSetting(shown, async (updates) => {
    const next: Bot = {
      ...shown,
      ...(updates.avatar !== undefined ? { avatar: updates.avatar } : {}),
      ...(updates.avatarColor !== undefined ? { avatarColor: updates.avatarColor } : {})
    }
    setShown(next)
    return next
  })
  return (
    <div className="flex h-[360px] items-start gap-4 p-6">
      <BotPictureButton
        bot={shown}
        picture={picture}
        avatarClassName="size-12 rounded-lg text-xl"
      />
      <div className="pt-3 text-lg font-semibold">{shown.name}</div>
    </div>
  )
}

export const settings = defineFixture({
  width: 420,
  setup: () => stubBots([idle]),
  render: () => <ShapeSettings />,
  interact: async (frame) => {
    frame.querySelector<HTMLButtonElement>('button[aria-label="Edit bot picture"]')?.click()
    await new Promise((resolve) => setTimeout(resolve, 350))
  }
})
