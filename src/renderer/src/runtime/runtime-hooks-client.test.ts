import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  checkRuntimeHooks,
  readRuntimeIssueCommand,
  writeRuntimeIssueCommand
} from './runtime-hooks-client'

const runtimeEnvironmentCall = vi.fn()
const hooksCheck = vi.fn()
const hooksReadIssueCommand = vi.fn()
const hooksWriteIssueCommand = vi.fn()

beforeEach(() => {
  runtimeEnvironmentCall.mockReset()
  hooksCheck.mockReset()
  hooksReadIssueCommand.mockReset()
  hooksWriteIssueCommand.mockReset()
  vi.stubGlobal('window', {
    api: {
      runtimeEnvironments: { call: runtimeEnvironmentCall },
      hooks: {
        check: hooksCheck,
        readIssueCommand: hooksReadIssueCommand,
        writeIssueCommand: hooksWriteIssueCommand
      }
    }
  })
})

describe('runtime hooks client', () => {
  it('uses local hook IPC when no runtime environment is active', async () => {
    hooksCheck.mockResolvedValue({ hasHooks: false, hooks: null, mayNeedUpdate: false })
    hooksReadIssueCommand.mockResolvedValue({
      localContent: null,
      sharedContent: null,
      effectiveContent: null,
      localFilePath: '',
      source: 'none'
    })

    await checkRuntimeHooks({ activeRuntimeEnvironmentId: null }, 'repo-1')
    await readRuntimeIssueCommand({ activeRuntimeEnvironmentId: null }, 'repo-1')
    await writeRuntimeIssueCommand({ activeRuntimeEnvironmentId: null }, 'repo-1', 'Fix it')

    expect(hooksCheck).toHaveBeenCalledWith({ repoId: 'repo-1' })
    expect(hooksReadIssueCommand).toHaveBeenCalledWith({ repoId: 'repo-1' })
    expect(hooksWriteIssueCommand).toHaveBeenCalledWith({ repoId: 'repo-1', content: 'Fix it' })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('routes hook operations through the active runtime environment', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: { ok: true },
      _meta: { runtimeId: 'runtime-1' }
    })

    await checkRuntimeHooks({ activeRuntimeEnvironmentId: 'env-1' }, 'repo-1')
    await readRuntimeIssueCommand({ activeRuntimeEnvironmentId: 'env-1' }, 'repo-1')
    await writeRuntimeIssueCommand({ activeRuntimeEnvironmentId: 'env-1' }, 'repo-1', 'Fix it')

    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(1, {
      selector: 'env-1',
      method: 'repo.hooksCheck',
      params: { repo: 'repo-1' },
      timeoutMs: 15_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(2, {
      selector: 'env-1',
      method: 'repo.issueCommandRead',
      params: { repo: 'repo-1' },
      timeoutMs: 15_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(3, {
      selector: 'env-1',
      method: 'repo.issueCommandWrite',
      params: { repo: 'repo-1', content: 'Fix it' },
      timeoutMs: 15_000
    })
    expect(hooksCheck).not.toHaveBeenCalled()
    expect(hooksReadIssueCommand).not.toHaveBeenCalled()
    expect(hooksWriteIssueCommand).not.toHaveBeenCalled()
  })
})
