import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SharedBotHostView } from '../../../../../shared/bots/shared-bot-hosts'
import { ensureRuntimeEnvironmentCompatible } from '../../rpc/compatibility/runtime-compatibility-probe'
import { runtimeEnvironmentSupportsCapability } from '../../rpc/compatibility/runtime-capability-proof'
import { installSharedBotHostCatalog } from './shared-bot-host-catalog'

const HOST: SharedBotHostView = {
  environmentId: 'shared-env',
  shareId: 'share-1',
  botId: 'bot-1',
  botName: 'Ivy',
  ownerName: 'Jinwoo Hong',
  homeWorkspaceId: 'home-1',
  link: 'live'
}

let uninstall: () => void
const call = vi.fn()
const environmentCall = vi.fn()

beforeEach(async () => {
  call.mockReset()
  environmentCall.mockReset()
  vi.stubGlobal('window', {
    api: {
      sharedBotHosts: { list: async () => [HOST], onChanged: () => () => {}, call },
      runtimeEnvironments: { call: environmentCall }
    }
  })
  uninstall = installSharedBotHostCatalog()
  await Promise.resolve()
})

afterEach(() => {
  uninstall()
  vi.unstubAllGlobals()
})

describe('what a teammate’s Orca asks a shared agent’s host', () => {
  it('probes no status: the host answers none to a share', async () => {
    await expect(ensureRuntimeEnvironmentCompatible(HOST.environmentId)).resolves.toBeNull()
    // A capability read refuses as the host would; the paired-server registry is never asked.
    await expect(
      runtimeEnvironmentSupportsCapability(HOST.environmentId, 'agent-session.rewind')
    ).rejects.toMatchObject({ code: 'method_not_found' })
    expect(environmentCall).not.toHaveBeenCalled()
    expect(call).not.toHaveBeenCalled()
  })
})
