import React from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { ConfirmationDialogProvider } from '../dismiss/confirmation/confirmation-dialog'
import { Button } from '../ui/button'
import { useAppStore } from '@/store'
import { stampBotHost } from '@/lib/bot-catalog-snapshot'
import { getDefaultSettings } from '../../../../shared/orca-profiles/constants'
import { RUNTIME_PROTOCOL_VERSION } from '../../../../shared/remote-runtime/protocol/protocol-version'
import { BotWhoCanAskInsetList } from './BotWhoCanAskInsetList'
import type { BotWhoCanAskService } from './BotWhoCanAskList'
import { useConfirmBotAccess } from './bot-access-confirm'

const HOST = 'runtime:access-example'
const remote = stampBotHost(HOST, {
  id: 'access-example',
  name: 'Helper',
  hostId: 'local',
  folder: 'helper',
  folderWorkspaceId: 'access-example-home',
  agent: 'claude',
  avatar: null,
  paused: false,
  permissionMode: 'ask',
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: { appId: 'A1', teamId: 'T1' },
  linear: null,
  github: null,
  chatSessionId: null,
  createdAt: 1,
  updatedAt: 1
})
const service: BotWhoCanAskService = {
  listed: () => [],
  stamp: { source: 'slack' },
  max: 200,
  search: async () => ({ ok: true, value: { members: [], complete: true } }),
  errorMessage: () => 'Unavailable',
  searchPlaceholder: 'Search people in Acme',
  peopleHeading: 'People in Acme',
  noMatch: () => ({ title: 'No matching people', detail: '' }),
  ownerId: 'U-owner',
  ownerName: 'Alex Morgan',
  kind: 'slack',
  connector: 'Slack',
  workspace: 'Acme',
  outsiders: 'Ask the owner for access.',
  notYet: 'Connect Slack',
  accessRequests: null
}
function setup(): void {
  useAppStore.setState((state) => ({
    settings: {
      ...(state.settings ?? getDefaultSettings('/home/fixture')),
      hostSettingOverrides: { [HOST]: { displayLabel: 'Atlas Server' } }
    }
  }))
  window.api.runtimeEnvironments.call = async ({ method }) => ({
    id: 'access-example',
    ok: true,
    _meta: { runtimeId: 'access-example' },
    result:
      method === 'status.get'
        ? { runtimeId: 'access-example', runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION }
        : method === 'orcaAccount.status'
          ? {
              state: 'signed-in',
              displayName: 'Alex Morgan',
              email: 'alex@example.test',
              storage: { kind: 'os-keychain' }
            }
          : method === 'google.status'
            ? { client: null, accounts: [], bots: [] }
            : {}
  })
}
function OpenConfirm(): React.JSX.Element {
  const confirm = useConfirmBotAccess()
  return (
    <Button
      onClick={() =>
        void confirm({
          botName: remote.name,
          people: [{ id: 'U-dana', name: 'Dana Kim', identity: '@dana' }],
          connector: 'Slack',
          workspace: 'Acme',
          details: { bot: remote, connector: 'slack' }
        })
      }
    >
      Add people
    </Button>
  )
}
export const remoteWarning = defineFixture({
  width: 390,
  setup,
  render: () => (
    <ConfirmationDialogProvider>
      <div className="bg-sidebar p-3 text-sidebar-foreground">
        <BotWhoCanAskInsetList bot={remote} service={service} />
      </div>
    </ConfirmationDialogProvider>
  )
})
export const remoteConfirm = defineFixture({
  width: 900,
  setup,
  render: () => (
    <ConfirmationDialogProvider>
      <div className="min-h-[640px]">
        <OpenConfirm />
      </div>
    </ConfirmationDialogProvider>
  ),
  interact: async (frame) => {
    const trigger = frame.querySelector('button')
    if (!trigger) {
      throw new Error('Access trigger missing')
    }
    trigger.click()
  }
})
