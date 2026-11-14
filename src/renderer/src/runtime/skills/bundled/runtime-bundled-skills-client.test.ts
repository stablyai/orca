import { beforeEach, describe, expect, it, vi } from 'vitest'
import { autoUpdateBundledSkillsOnTarget } from './runtime-bundled-skills-client'
import { clearRuntimeCompatibilityCache } from '../../rpc/compatibility/runtime-compatibility-cache'
import { replaceRuntimeEnvironmentRevisions } from '../../rpc/environment-revisions/runtime-environment-revision'
import { BUNDLED_ORCA_SKILL_AUTO_UPDATE_CAPABILITY } from '../../../../../shared/skill-install-capability'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../../../shared/protocol-version'

const ENVIRONMENT_ID = 'server-1'
const target = { kind: 'environment' as const, environmentId: ENVIRONMENT_ID }

type CallArgs = {
  selector: string
  method: string
  params?: unknown
  expectedEnvironmentPairingRevision?: number
  expectedEnvironmentRuntimeId?: string
}
const call = vi.fn<(args: CallArgs) => unknown>()

function setPairingRevision(pairingRevision: number): void {
  replaceRuntimeEnvironmentRevisions([{ id: ENVIRONMENT_ID, createdAt: 1, pairingRevision }])
}

function status(runtimeId: string) {
  return {
    id: 'status',
    ok: true,
    result: {
      runtimeId,
      runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
      capabilities: [BUNDLED_ORCA_SKILL_AUTO_UPDATE_CAPABILITY]
    },
    _meta: { runtimeId }
  }
}

beforeEach(() => {
  clearRuntimeCompatibilityCache()
  setPairingRevision(41)
  call.mockReset()
  vi.stubGlobal('window', { api: { runtimeEnvironments: { call } } })
})

describe('silent skill update on a paired server', () => {
  it('sends the update only to the runtime and pairing that answered the capability check', async () => {
    call.mockImplementation(async (args) =>
      args.method === 'status.get'
        ? status('runtime-a')
        : { id: 'u', ok: true, result: { scope: 'global', skills: [] }, _meta: {} }
    )

    await autoUpdateBundledSkillsOnTarget(target, ['orca-cli'], { recordOnly: true })

    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'skills.autoUpdateBundledOrca',
        params: { names: ['orca-cli'], recordOnly: true },
        expectedEnvironmentPairingRevision: 41,
        expectedEnvironmentRuntimeId: 'runtime-a'
      })
    )
  })

  it('never sends the update when the server is re-paired while the capability check awaits', async () => {
    call.mockImplementation(async (args) => {
      if (args.method === 'status.get') {
        // Another host takes over this saved server before its status answer arrives.
        setPairingRevision(42)
        return status('runtime-b')
      }
      return { id: 'u', ok: true, result: { scope: 'global', skills: [] }, _meta: {} }
    })

    await expect(autoUpdateBundledSkillsOnTarget(target, ['orca-cli'])).rejects.toThrow()
    expect(call).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'skills.autoUpdateBundledOrca' })
    )
  })
})
