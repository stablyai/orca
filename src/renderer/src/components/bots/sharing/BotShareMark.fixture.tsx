import { defineFixture } from '../../../component-fixtures/component-fixture'
import { publishBots, setBotHostListing, stampBotHost } from '@/lib/bot-catalog-snapshot'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { installSharedBotHostCatalog } from '@/runtime/hosts/shared-bot-hosts/shared-bot-host-catalog'
import type { Bot } from '../../../../../shared/bot-types'
import type { SharedBotHostView } from '../../../../../shared/bots/shared-bot-hosts'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import { ConfirmationDialogProvider } from '../../dismiss/confirmation/confirmation-dialog'
import { BotHoverDetails, useBotRowDetails } from '../BotHoverDetails'
import { BotRow } from '../BotRow'

const SHARED: SharedBotHostView = {
  environmentId: 'shared-ivy',
  shareId: 'share-ivy',
  botId: 'ivy',
  botName: 'Ivy',
  ownerName: 'Jinwoo Hong',
  link: 'live'
}
const SHARED_HOST = toRuntimeExecutionHostId(SHARED.environmentId)

function bot(id: string, name: string, hostId: ExecutionHostId, fields: Partial<Bot> = {}): Bot {
  return stampBotHost(hostId, {
    id,
    name,
    hostId: LOCAL_EXECUTION_HOST_ID,
    folder: id,
    folderWorkspaceId: `fw-${id}`,
    agent: 'claude',
    avatar: null,
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
  })
}

// Alice's Orca: Jinwoo's Ivy, shared with her. Jinwoo's Orca: his Release manager, shared with two people.
const ivy = bot('ivy', 'Ivy', SHARED_HOST)
const docs = bot('docs', 'Docs bot', LOCAL_EXECUTION_HOST_ID)
const release = bot('release', 'Release manager', LOCAL_EXECUTION_HOST_ID, {
  shares: [
    {
      kind: 'account',
      shareId: 'a',
      accountId: 'alice',
      name: 'Alice Chen',
      email: 'alice@example.com',
      addedAt: 1
    },
    {
      kind: 'account',
      shareId: 'b',
      accountId: 'bo',
      name: 'Bo Park',
      email: 'bo@example.com',
      addedAt: 1
    }
  ]
})

const home = (owner: Bot) =>
  makeFolderWorkspace({
    id: owner.folderWorkspaceId,
    name: owner.name,
    folderPath: '',
    executionHostId: owner.hostId
  })

function Hover({ owner }: { owner: Bot }): React.JSX.Element {
  const details = useBotRowDetails(owner, home(owner))
  return (
    <div className="w-[360px] rounded-md border border-border bg-popover p-3 text-xs text-popover-foreground shadow-md">
      <BotHoverDetails
        bot={owner}
        details={details}
        showHostOnFocus={false}
        onOpenHome={() => {}}
      />
    </div>
  )
}

function Side({ label, rows, hover }: { label: string; rows: Bot[]; hover: Bot }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="flex items-start gap-3">
        <div className="flex w-[280px] flex-col rounded-lg border border-border bg-worktree-sidebar py-1 pr-1.5 text-worktree-sidebar-foreground">
          {rows.map((owner) => (
            <BotRow
              key={owner.id}
              bot={owner}
              home={home(owner)}
              isActive={owner === hover}
              onOpen={() => {}}
            />
          ))}
        </div>
        <Hover owner={hover} />
      </div>
    </div>
  )
}

export const sharedBotRows = defineFixture({
  width: 720,
  setup: () => {
    // Host reads stay pending: the rows and cards render from the listing alone.
    const pending = () => new Promise<never>(() => {})
    Reflect.set(window.api, 'sharedBotHosts', {
      list: () => Promise.resolve([SHARED]),
      onChanged: () => () => {},
      call: pending
    })
    Reflect.set(window.api, 'runtime', { ...window.api.runtime, call: pending })
    installSharedBotHostCatalog()
    setBotHostListing({
      hosts: [
        { hostId: LOCAL_EXECUTION_HOST_ID, state: 'live' },
        { hostId: SHARED_HOST, state: 'live' }
      ],
      updateNeeded: []
    })
    const answer = { threadReplies: false, webhooks: undefined }
    publishBots([docs, release], answer)
    publishBots([ivy], answer, SHARED_HOST)
  },
  render: () => (
    <ConfirmationDialogProvider>
      <div className="flex flex-col gap-4 bg-background p-3">
        <Side label="Shared with you" rows={[ivy, docs]} hover={ivy} />
        <Side label="You share it" rows={[release, docs]} hover={release} />
      </div>
    </ConfirmationDialogProvider>
  )
})
