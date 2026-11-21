// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@/lib/bot-catalog', async () => {
  const { useSyncExternalStore } = await import('react')
  const snapshot = await import('@/lib/bot-catalog-snapshot')
  return {
    useHostBots: (hostId: Parameters<typeof snapshot.readHostBots>[0]) =>
      useSyncExternalStore(snapshot.subscribeToBotChanges, () => snapshot.readHostBots(hostId))
  }
})
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/orca-profiles/constants'
import type { Bot } from '../../../../shared/bot-types'
import type { RuntimeHostStatusSnapshot } from '../../../../shared/remote-runtime/host-status/runtime-host-status'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { publicRuntimeEnvironment } from '@/runtime/rpc/testing/paired-runtime-environment-test-fixture'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/rpc/testing/runtime-compatibility-test-fixture'
import { publishBots, setBotHostListing, stampBotHost } from '@/lib/bot-catalog-snapshot'
import { ConfirmationDialogProvider } from '../dismiss/confirmation/confirmation-dialog'
import { BotAccessControlLine } from './BotAccessReach'
import { useConfirmBotAccess } from './bot-access-confirm'

const initial = useAppStore.getState()
const local: Bot = {
  id: 'access-example',
  name: 'Helper',
  hostId: 'local',
  folder: 'helper',
  folderWorkspaceId: 'access-home',
  agent: 'claude',
  avatar: null,
  paused: false,
  permissionMode: 'ask',
  google: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: { appId: 'A1', teamId: 'T1' },
  linear: null,
  github: null,
  chatSessionId: null,
  createdAt: 1,
  updatedAt: 1
}
const remote = stampBotHost('runtime:access-host', local)
function pair(revision: number, fields: Partial<PublicKnownRuntimeEnvironment> = {}): void {
  useAppStore.getState().setRuntimeEnvironments([
    publicRuntimeEnvironment({
      id: 'access-host',
      name: 'Orca Server',
      pairingRevision: revision,
      ...fields
    })
  ])
}
function status(revision: number, machineName?: string): RuntimeHostStatusSnapshot {
  return {
    environmentId: 'access-host',
    pairingRevision: revision,
    sequence: revision,
    checkedAt: revision,
    verification: 'verified',
    transport: 'ready',
    status: { ...createCompatibleRuntimeStatusResponse(`runtime-${revision}`).result, machineName }
  }
}
function receive(snapshot: RuntimeHostStatusSnapshot): void {
  act(() => useAppStore.getState().applyRuntimeHostStatusSnapshot(snapshot))
}
function Access({ bot }: { bot: Bot }): React.JSX.Element {
  const confirm = useConfirmBotAccess()
  return (
    <>
      <section aria-label="Persistent warning">
        <BotAccessControlLine bot={bot} others={[]} />
      </section>
      <button
        type="button"
        onClick={() =>
          void confirm({
            botName: bot.name,
            people: [{ id: 'U-dana', name: 'Dana' }],
            connector: 'Slack',
            workspace: 'Acme',
            details: { bot, connector: 'slack' }
          })
        }
      >
        Add people
      </button>
    </>
  )
}
function show(bot = local): void {
  render(
    <ConfirmationDialogProvider>
      <Access bot={bot} />
    </ConfirmationDialogProvider>
  )
}
async function expectWarningAndConsent(name: string): Promise<void> {
  expect(
    within(screen.getByRole('region', { name: 'Persistent warning' })).getByText(new RegExp(name))
  ).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Add people' }))
  expect(await screen.findByRole('dialog')).toHaveAccessibleDescription(new RegExp(name))
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
}
beforeEach(() => {
  vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
  useAppStore.setState({
    settings: {
      ...getDefaultSettings('/fixture')
    }
  })
  setBotHostListing({
    hosts: [
      { hostId: 'local', state: 'live' },
      { hostId: 'runtime:access-host', state: 'live' }
    ],
    updateNeeded: []
  })
  publishBots([local])
  publishBots([remote], undefined, 'runtime:access-host')
  pair(1)
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
  vi.unstubAllGlobals()
})

describe('paired access host identity', () => {
  it('names the verified machine for a runtime-stamped web grant', async () => {
    receive(status(1, 'Atlas Server'))
    show(remote)
    await expectWarningAndConsent('Atlas Server')
  })
  it('uses neutral wording before the current pairing identifies its machine', async () => {
    show()
    await expectWarningAndConsent('the computer this agent runs on')
    receive({ ...status(1, 'Unverified Server'), verification: 'checking' })
    await expectWarningAndConsent('the computer this agent runs on')
    expect(screen.queryByText(/Unverified Server/)).toBeNull()
  })
  it('ignores a late status delivery from the previous pairing', async () => {
    receive(status(1, 'Atlas Server'))
    show()
    await expectWarningAndConsent('Atlas Server')
    let deliver: (snapshot: RuntimeHostStatusSnapshot) => void = () => {}
    const late = new Promise<RuntimeHostStatusSnapshot>((resolve) => {
      deliver = resolve
    }).then((snapshot) => useAppStore.getState().applyRuntimeHostStatusSnapshot(snapshot))
    act(() => pair(2))
    receive(status(2, 'Boreal Server'))
    await act(async () => {
      deliver({ ...status(1, 'Atlas Server'), sequence: 99 })
      await late
    })
    await expectWarningAndConsent('Boreal Server')
    expect(screen.queryByText(/Atlas Server/)).toBeNull()
  })
  it('drops the retired peer’s machine name before naming its replacement', async () => {
    const deployment = {
      kind: 'wsl',
      distro: 'Ubuntu',
      localPort: 46768,
      remotePort: 6768
    } as const
    act(() => pair(1, { orcadDeployment: deployment, hostKeyFingerprint: 'key-atlas' }))
    receive(status(1, 'Atlas Server'))
    show(remote)
    await expectWarningAndConsent('Atlas Server')
    act(() => pair(2, { orcadDeployment: deployment, hostKeyFingerprint: 'key-boreal' }))
    await expectWarningAndConsent('the computer this agent runs on')
    receive(status(2, 'Boreal Server'))
    receive({ ...status(1, 'Atlas Server'), sequence: 99 })
    await expectWarningAndConsent('Boreal Server')
    expect(screen.queryByText(/Atlas Server/)).toBeNull()
  })
})
