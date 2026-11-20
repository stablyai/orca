import { defineFixture } from '../../component-fixtures/component-fixture'
import { stubBots, stubServerBots } from '../../component-fixtures/fixture-bots'
import { publishBots, setBotHostListing } from '@/lib/bot-catalog-snapshot'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/rpc/testing/runtime-compatibility-test-fixture'
import { mascotAvatar, type BotMascotId } from '../../../../shared/bot-avatar'
import type { Bot } from '../../../../shared/bot-types'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { ConfirmationDialogProvider } from '../dismiss/confirmation/confirmation-dialog'
import { BotGroupMembersDialog } from './BotGroupMembersDialog'

// Bots on two computers: two here, two on a paired workstation. A group can hold only one computer's.
const WORKSTATION: ExecutionHostId = 'runtime:workstation'

function bot(id: string, name: string, mascot: BotMascotId): Bot {
  // A host stores its own bots as `local`; the listing stamps the host that read them.
  return {
    id,
    name,
    hostId: 'local',
    folder: id,
    folderWorkspaceId: `fw-${id}`,
    agent: 'claude',
    avatar: mascotAvatar(mascot),
    paused: false,
    notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
    members: [],
    slack: null,
    linear: null,
    github: null,
    chatSessionId: null,
    createdAt: 1,
    updatedAt: 1
  }
}

const here = [bot('star', 'Star 管家王', 'K2'), bot('notes', 'Release notes', 'H1')]
const away = [bot('dispatch', 'Workstation 管家', 'B1'), bot('builds', 'Nightly builds', 'F1')]
const PURPOSES: Record<string, string> = {
  star: '我是你的私人管家：盯住各台设备和各个项目，每天早上汇报进度',
  notes: 'Drafts release notes from merged pull requests',
  dispatch: '我负责接收、分配和监控各 agent 提交给 windows-workstation 的任务',
  builds: 'Runs the nightly build and reports failures'
}

function scene(pick?: string) {
  return defineFixture({
    width: 560,
    store: {
      runtimeEnvironments: [
        {
          id: 'workstation',
          name: 'Workstation',
          createdAt: 1,
          updatedAt: 1,
          lastUsedAt: null,
          runtimeId: null,
          endpoints: [],
          preferredEndpointId: 'workstation'
        }
      ],
      runtimeStatusByEnvironmentId: new Map([
        [
          'workstation',
          { status: createCompatibleRuntimeStatusResponse('workstation').result, checkedAt: 1 }
        ]
      ])
    },
    setup: () => {
      setBotHostListing({
        hosts: [
          { hostId: 'local', state: 'live' },
          { hostId: WORKSTATION, state: 'live' }
        ],
        updateNeeded: []
      })
      stubBots(here, PURPOSES)
      publishBots(away, { threadReplies: false, webhooks: undefined }, WORKSTATION)
      stubServerBots({ workstation: away }, {}, PURPOSES)
    },
    render: () => (
      <ConfirmationDialogProvider>
        <BotGroupMembersDialog onClose={() => {}} />
      </ConfirmationDialogProvider>
    ),
    interact: pick
      ? () => {
          const row = [...document.querySelectorAll<HTMLElement>('[role="checkbox"]')].find(
            (entry) => entry.textContent?.includes(pick)
          )
          row?.click()
        }
      : undefined
  })
}

/** 1 · Bots on two computers: each row says which. */
export const twoComputers = scene()

/** 2 · A workstation bot picked: this computer's bots stay listed, dimmed, and the line says why. */
export const pickedOnWorkstation = scene('Workstation 管家')
