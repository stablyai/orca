// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { setBotHostListing, stampBotHost } from '@/lib/bot-catalog-snapshot'
import { publishBotGroups, readBotGroups } from '@/lib/bot-group-catalog-snapshot'
import { useAppStore } from '@/store'
import { mascotAvatar } from '../../../../shared/bot-avatar'
import type { Bot } from '../../../../shared/bot-types'
import type { BotGroup } from '../../../../shared/bots/bot-group'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import { ConfirmationDialogProvider } from '../dismiss/confirmation/confirmation-dialog'
import { BotGroupPanelHeader } from './BotGroupPanelHeader'

const M4: ExecutionHostId = 'runtime:m4'

const GROUP: BotGroup = {
  id: 'g1',
  name: 'Release crew',
  hostId: LOCAL_EXECUTION_HOST_ID,
  revision: 1,
  folder: 'group-crew',
  folderWorkspaceId: 'fw-g1',
  createdAt: 1,
  replyMode: { kind: 'mentions' },
  members: []
}
const BOT: Bot = {
  id: 'b1',
  name: 'Docs bot',
  hostId: LOCAL_EXECUTION_HOST_ID,
  folder: 'docs',
  folderWorkspaceId: 'fw-b1',
  agent: 'claude',
  avatar: mascotAvatar('M1'),
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: 'chat-b1',
  createdAt: 1,
  updatedAt: 1
}

function listM4(state: 'live' | 'offline'): void {
  act(() => {
    setBotHostListing({
      hosts: [
        { hostId: LOCAL_EXECUTION_HOST_ID, state: 'live' },
        { hostId: M4, state }
      ],
      updateNeeded: []
    })
  })
}

/** The group as m4 air's listing stamps it. */
function groupOnM4(): BotGroup {
  listM4('live')
  publishBotGroups([GROUP], M4)
  const stamped = readBotGroups().find((group) => group.hostId === M4)
  if (!stamped) {
    throw new Error('m4 air listed no group')
  }
  return stamped
}

function mount(group: BotGroup, members: Bot[]): () => string {
  const { container } = render(
    <TooltipProvider>
      <ConfirmationDialogProvider>
        <BotGroupPanelHeader
          group={group}
          members={members}
          needsYou={0}
          working={0}
          next={null}
          now={0}
          filter={null}
        />
      </ConfirmationDialogProvider>
    </TooltipProvider>
  )
  return () => container.textContent ?? ''
}

beforeEach(() => {
  useAppStore.setState({
    runtimeEnvironments: [
      {
        id: 'm4',
        name: 'm4 air',
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: null,
        runtimeId: null,
        endpoints: [],
        preferredEndpointId: 'm4'
      }
    ]
  })
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(globalThis, '__ORCA_WEB_CLIENT__')
})

describe("a group header follows its own server's connection", () => {
  it('says an empty remote group is disconnected while its server is down, and recovers', () => {
    const text = mount(groupOnM4(), [])
    expect(text()).toContain('m4 air')
    expect(text()).not.toContain('Disconnected')
    listM4('offline')
    expect(text()).toContain('Disconnected')
    listM4('live')
    expect(text()).not.toContain('Disconnected')
  })

  it('says a remote group with members is disconnected while its server is down', () => {
    const group = groupOnM4()
    listM4('offline')
    expect(mount(group, [stampBotHost(M4, BOT)])()).toContain('Disconnected')
  })

  it("leaves this computer's group without a server or a connection state", () => {
    listM4('offline')
    const text = mount(GROUP, [BOT])()
    expect(text).not.toContain('m4 air')
    expect(text).not.toContain('Disconnected')
  })

  it('leaves a paired web window, whose groups are all on its server, as before', () => {
    const group = groupOnM4()
    Reflect.set(globalThis, '__ORCA_WEB_CLIENT__', true)
    listM4('offline')
    const text = mount(group, [])()
    expect(text).not.toContain('m4 air')
    expect(text).not.toContain('Disconnected')
  })
})
