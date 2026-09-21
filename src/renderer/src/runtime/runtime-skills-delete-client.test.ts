import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SKILL_DELETE_UPDATE_REQUIRED_MESSAGE } from '../../../shared/skill-install-capability'
import type { SkillDeleteRequest } from '../../../shared/skill-delete-contract'

const callRuntimeRpc = vi.fn()
const runtimeEnvironmentSupportsCapability = vi.fn()
const assertRuntimeEnvironmentCapability = vi.fn()

vi.mock('./runtime-rpc-client', () => ({
  callRuntimeRpc: (...args: unknown[]) => callRuntimeRpc(...args),
  runtimeEnvironmentSupportsCapability: (...args: unknown[]) =>
    runtimeEnvironmentSupportsCapability(...args),
  assertRuntimeEnvironmentCapability: (...args: unknown[]) =>
    assertRuntimeEnvironmentCapability(...args)
}))

const {
  deleteSkillsOnRuntimeTarget,
  previewSkillDeletionOnRuntimeTarget,
  runtimeTargetSupportsSkillDelete
} = await import('./runtime-skills-client')

const REQUEST: SkillDeleteRequest = {
  operationId: 'op',
  skills: [
    { id: 'a', directoryPath: '/d', skillFilePath: '/d/SKILL.md', name: 'demo', updatedAt: 1 }
  ]
}

const localDelete = vi.fn()
const localPreview = vi.fn()
const localDeleteSupported = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  localDeleteSupported.mockResolvedValue(true)
  vi.stubGlobal('window', {
    api: {
      skills: {
        delete: localDelete,
        previewDelete: localPreview,
        deleteSupported: localDeleteSupported
      }
    }
  })
})

describe('runtimeTargetSupportsSkillDelete', () => {
  it('asks the preload, not the environment probe, for the local target', async () => {
    expect(await runtimeTargetSupportsSkillDelete({ kind: 'local' })).toBe(true)
    expect(localDeleteSupported).toHaveBeenCalled()
    expect(runtimeEnvironmentSupportsCapability).not.toHaveBeenCalled()
  })

  it('is unsupported when the web "local" host predates the capability', async () => {
    localDeleteSupported.mockResolvedValue(false)
    expect(await runtimeTargetSupportsSkillDelete({ kind: 'local' })).toBe(false)
  })

  it('is unsupported while the runtime target is still unresolved', async () => {
    expect(await runtimeTargetSupportsSkillDelete(null)).toBe(false)
    expect(runtimeEnvironmentSupportsCapability).not.toHaveBeenCalled()
  })

  it('asks the environment for the capability', async () => {
    runtimeEnvironmentSupportsCapability.mockResolvedValue(false)
    expect(
      await runtimeTargetSupportsSkillDelete({ kind: 'environment', environmentId: 'env-1' })
    ).toBe(false)
    expect(runtimeEnvironmentSupportsCapability).toHaveBeenCalledWith('env-1', 'skills.delete.v1')
  })
})

describe('delete routing', () => {
  it('issues no RPC against a host that lacks the capability', async () => {
    assertRuntimeEnvironmentCapability.mockRejectedValue(
      new Error(SKILL_DELETE_UPDATE_REQUIRED_MESSAGE)
    )
    await expect(
      deleteSkillsOnRuntimeTarget({ kind: 'environment', environmentId: 'env-1' }, REQUEST)
    ).rejects.toThrow(SKILL_DELETE_UPDATE_REQUIRED_MESSAGE)
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('routes a local delete through IPC rather than RPC', async () => {
    localDelete.mockResolvedValue({ operationId: 'op', skills: [] })
    await deleteSkillsOnRuntimeTarget({ kind: 'local' }, REQUEST)
    expect(localDelete).toHaveBeenCalledWith(REQUEST)
    expect(callRuntimeRpc).not.toHaveBeenCalled()
    expect(assertRuntimeEnvironmentCapability).not.toHaveBeenCalled()
  })

  it('refuses a local delete when the web "local" host lacks the capability', async () => {
    localDeleteSupported.mockResolvedValue(false)
    await expect(deleteSkillsOnRuntimeTarget({ kind: 'local' }, REQUEST)).rejects.toThrow(
      SKILL_DELETE_UPDATE_REQUIRED_MESSAGE
    )
    expect(localDelete).not.toHaveBeenCalled()
  })

  it('sends the whole request to a capable remote host', async () => {
    assertRuntimeEnvironmentCapability.mockResolvedValue(undefined)
    callRuntimeRpc.mockResolvedValue({ operationId: 'op', skills: [] })
    await deleteSkillsOnRuntimeTarget({ kind: 'environment', environmentId: 'env-1' }, REQUEST)
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'skills.delete',
      REQUEST,
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    )
  })

  it('gates the preview on the same capability', async () => {
    assertRuntimeEnvironmentCapability.mockRejectedValue(new Error('nope'))
    await expect(
      previewSkillDeletionOnRuntimeTarget({ kind: 'environment', environmentId: 'env-1' }, REQUEST)
    ).rejects.toThrow('nope')
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })
})
