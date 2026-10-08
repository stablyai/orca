import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizePerforceSettings } from '../../../shared/perforce/perforce-settings'
import type * as RuntimeRpcClient from './runtime-rpc-client'
import {
  generatePerforceDescription,
  runPerforceCopyOperation,
  runPerforceOperation,
  type PerforceWorkspaceTarget
} from './runtime-perforce-client'

const rpc = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(),
  assertRuntimeEnvironmentCapability: vi.fn()
}))

vi.mock('./runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpcClient>()),
  callRuntimeRpc: rpc.callRuntimeRpc,
  assertRuntimeEnvironmentCapability: rpc.assertRuntimeEnvironmentCapability
}))

const run = vi.fn()
const runCopy = vi.fn()
const generateDescription = vi.fn()

function target(environmentId: string | null): PerforceWorkspaceTarget {
  return {
    settings: {
      activeRuntimeEnvironmentId: environmentId,
      perforce: normalizePerforceSettings({ p4Path: 'C:\\p4\\p4.exe', p4Port: 'ssl:p4:1666' }),
      defaultTuiAgent: 'blank'
    },
    worktreeId: 'repo-1::/srv/ws',
    worktreePath: '/srv/ws',
    connectionId: 'nested-target'
  }
}

beforeEach(() => {
  rpc.callRuntimeRpc.mockReset().mockResolvedValue({ entries: [] })
  rpc.assertRuntimeEnvironmentCapability.mockReset().mockResolvedValue(undefined)
  run.mockReset().mockResolvedValue({ entries: [] })
  runCopy.mockReset().mockResolvedValue({ ok: true, value: true })
  generateDescription.mockReset().mockResolvedValue({ success: true, message: 'm' })
  vi.stubGlobal('window', { api: { perforce: { run, runCopy, generateDescription } } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('runPerforceOperation', () => {
  it('runs a workspace on this desktop or its SSH hosts through IPC', async () => {
    await runPerforceOperation(target(null), 'open', { filePaths: ['a.cs'] })
    expect(run).toHaveBeenCalledWith('open', {
      filePaths: ['a.cs'],
      worktreePath: '/srv/ws',
      connectionId: 'nested-target'
    })
    expect(rpc.callRuntimeRpc).not.toHaveBeenCalled()
  })

  it("sends a server-owned workspace to that server, with this user's settings minus machine paths", async () => {
    await runPerforceOperation(target('env-1'), 'status', {})
    expect(rpc.assertRuntimeEnvironmentCapability).toHaveBeenCalledWith(
      'env-1',
      'perforce.v1',
      expect.stringContaining('Update Orca on that host')
    )
    const [runtimeTarget, method, params, options] = rpc.callRuntimeRpc.mock.calls[0] ?? []
    expect(runtimeTarget).toEqual({ kind: 'environment', environmentId: 'env-1' })
    expect(method).toBe('perforce.status')
    expect(params).toMatchObject({
      worktree: 'id:repo-1::/srv/ws',
      settings: { p4Path: '', p4Port: 'ssl:p4:1666' }
    })
    expect(params).not.toHaveProperty('connectionId')
    expect(options.timeoutMs).toBeGreaterThan(30_000)
    expect(run).not.toHaveBeenCalled()
  })
})

describe('runPerforceCopyOperation', () => {
  it('reports a server that cannot answer as a failed result, like IPC does', async () => {
    rpc.assertRuntimeEnvironmentCapability.mockRejectedValue(new Error('Update Orca'))
    await expect(
      runPerforceCopyOperation(
        { settings: { activeRuntimeEnvironmentId: 'env-1' }, repoId: 'repo-1' },
        'syncCopies',
        {}
      )
    ).resolves.toEqual({ ok: false, error: 'Update Orca' })
  })

  it('names the project by id on the server', async () => {
    rpc.callRuntimeRpc.mockResolvedValue({ name: 'copy-1' })
    await expect(
      runPerforceCopyOperation(
        { settings: { activeRuntimeEnvironmentId: 'env-1' }, repoId: 'repo-1' },
        'previewCopyRemoval',
        { name: 'copy-1' }
      )
    ).resolves.toEqual({ ok: true, value: { name: 'copy-1' } })
    expect(rpc.callRuntimeRpc.mock.calls[0]?.[2]).toMatchObject({
      repo: 'id:repo-1',
      name: 'copy-1'
    })
  })

  it('uses IPC for a project this desktop owns', async () => {
    await runPerforceCopyOperation(
      { settings: { activeRuntimeEnvironmentId: null }, repoId: 'repo-1' },
      'detectProject',
      {}
    )
    expect(runCopy).toHaveBeenCalledWith('detectProject', { repoId: 'repo-1' })
  })
})

describe('generatePerforceDescription', () => {
  it("leaves 'no default agent' out so the server picks its own", async () => {
    await generatePerforceDescription(target('env-1'), { changelist: 'default', filePaths: ['a'] })
    const params = rpc.callRuntimeRpc.mock.calls[0]?.[2]
    expect(rpc.callRuntimeRpc.mock.calls[0]?.[1]).toBe('perforce.generateDescription')
    expect(params).not.toHaveProperty('defaultTuiAgent')
    expect(params).toMatchObject({ changelist: 'default', filePaths: ['a'] })
  })
})
