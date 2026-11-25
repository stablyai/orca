import { expect, it, vi } from 'vitest'
import { makeAutomation } from '../automations-page-fixtures'
import {
  captureBotAutomationOwners,
  botAutomationRowOwner,
  actOnBotAutomationRow
} from './bot-automation-row-owner'

const host = vi.hoisted(() => ({
  revision: 4,
  state: { runtimeEnvironments: [{ id: 'env-1', createdAt: 1, pairingRevision: 4 }] }
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => host.state } }))
vi.mock('@/runtime/rpc/environment-revisions/runtime-environment-revision', () => ({
  getRuntimeEnvironmentRevision: () => host.revision,
  isRuntimeEnvironmentContinuationPending: () => false,
  resolveContinuedRuntimeEnvironmentRevision: (_id: string, captured: number) => captured
}))
vi.mock('@/app-shell/platform/paired-web-client-host', () => ({
  getPairedWebClientEnvironmentId: () => null
}))

it('refuses a row read from a replaced pairing even when its bot and automation IDs still match', async () => {
  const bot = { hostId: 'runtime:env-1', id: 'b1' } as const
  const automation = makeAutomation({ id: 'a1' })
  const commit = captureBotAutomationOwners(bot)
  host.revision = 5
  host.state.runtimeEnvironments[0].pairingRevision = 5
  commit({
    workers: [],
    inProgress: [],
    completed: [],
    automations: [{ key: 'a1', automation, failing: false }],
    waits: []
  })
  const action = vi.fn(async () => 'changed')
  await expect(
    actOnBotAutomationRow(botAutomationRowOwner(automation, bot), action)
  ).rejects.toThrow('This computer changed.')
  expect(action).not.toHaveBeenCalled()
})
