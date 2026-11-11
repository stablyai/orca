import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import {
  dropDeletedRemoteResumeCwd,
  prepareAiVaultSessionForFork,
  prepareAiVaultSessionForTerminalResume
} from './ai-vault-session-resume-preparation'

import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'

const browseServerDir = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/files/reads/runtime-server-directory-browser', () => ({
  browseRuntimeServerDirectory: browseServerDir
}))

afterEach(() => {
  vi.unstubAllGlobals()
  browseServerDir.mockReset()
})

describe('ordinary Resume against an older paired host', () => {
  it.each([
    new Error(
      "Error invoking remote method 'aiVault:prepareSessionResume': Error: aiVault.prepareSessionResume: method_not_found"
    ),
    Object.assign(new Error('Unknown method: aiVault.prepareSessionResume'), {
      code: 'method_not_found'
    })
  ])('retains neutral resumes but requires managed Codex home preparation', async (error) => {
    stubPreparation(vi.fn().mockRejectedValue(error))
    const remote = session({ agent: 'claude', executionHostId: 'runtime:paired' })
    await expect(prepareAiVaultSessionForTerminalResume(remote)).resolves.toBe(remote)
    await expect(
      prepareAiVaultSessionForTerminalResume(
        session({
          executionHostId: 'runtime:paired',
          codexHome: '/tmp/orca/codex-runtime-home/home'
        })
      )
    ).rejects.toBe(error)
  })
})

describe('prepareAiVaultSessionForFork', () => {
  it("refuses a host that made no copy rather than resuming the chat's own conversation", async () => {
    stubPreparation(vi.fn().mockResolvedValue({ useRealCodexHome: false }))
    const owned = session({
      agent: 'omp',
      structuredSession: { sessionId: 'session-1', workspaceId: 'worktree-1' }
    })

    await expect(prepareAiVaultSessionForFork(owned)).rejects.toThrow(
      'Update Orca on the host that runs this chat to resume it in a new CLI.'
    )
  })
})

describe('dropDeletedRemoteResumeCwd', () => {
  it('keeps the recorded folder when the SSH host cannot answer', async () => {
    const pathExists = vi.fn().mockRejectedValue(new Error('CONNECTION_LOST'))
    vi.stubGlobal('window', { api: { fs: { pathExists } } })
    const remote = session({ executionHostId: 'ssh:server-1', cwd: '/home/ada/wt/feat-x' })

    // Losing the host cannot prove its folder is gone (ssh-execution-boundary.md).
    await expect(dropDeletedRemoteResumeCwd(remote)).resolves.toBe(remote)
    expect(pathExists).toHaveBeenCalled()
  })

  it('drops a paired server session folder only when that server reports it missing', async () => {
    serveHostWithMissingFolders('posix')
    const gone = session({
      executionHostId: 'runtime:env-1',
      cwd: '/srv/wt/gone',
      resumeCommand: "cd '/srv/wt/gone' && codex resume session-1"
    })

    const dropped = await dropDeletedRemoteResumeCwd(gone)

    expect(dropped.cwd).toBeNull()
    expect(dropped.resumeCommand).toBeUndefined()
    expect(browseServerDir).toHaveBeenCalledWith('env-1', '/srv/wt/gone')
  })

  it('keeps a paired server session folder that exists or cannot be checked', async () => {
    const remote = session({ executionHostId: 'runtime:env-1', cwd: '/srv/wt/live' })
    browseServerDir.mockResolvedValueOnce({ resolvedPath: '/srv/wt/live', entries: [] })
    await expect(dropDeletedRemoteResumeCwd(remote)).resolves.toBe(remote)

    // A dropped connection proves nothing about the folder.
    browseServerDir.mockRejectedValueOnce(new Error('Runtime environment is unreachable'))
    await expect(dropDeletedRemoteResumeCwd(remote)).resolves.toBe(remote)

    // A path that merely contains "not found" is not the host saying the folder is gone.
    browseServerDir.mockRejectedValueOnce(runtimeError('Workspace not found on this server'))
    await expect(dropDeletedRemoteResumeCwd(remote)).resolves.toBe(remote)
  })

  it('keeps a folder the server browser would trim into a different path', async () => {
    serveHostWithMissingFolders('posix')
    const padded = session({ executionHostId: 'runtime:env-1', cwd: '/srv/repo ' })

    await expect(dropDeletedRemoteResumeCwd(padded)).resolves.toBe(padded)
    expect(browseServerDir).not.toHaveBeenCalled()
  })

  it('rebuilds a deleted-folder resume for a Windows server with its shell', async () => {
    serveHostWithMissingFolders('win32')
    const gone = session({
      executionHostId: 'runtime:windows-server',
      cwd: 'C:\\Users\\ada\\wt\\gone',
      resumeCommand: "cd 'C:\\Users\\ada\\wt\\gone' && codex resume session-1"
    })

    const dropped = await dropDeletedRemoteResumeCwd(gone)

    expect(dropped.cwd).toBeNull()
    expect(dropped.executionHostPlatform).toBe('win32')
  })

  it("keeps a WSL session's Linux folder that its Windows host cannot stat", async () => {
    serveHostWithMissingFolders('win32')
    const wsl = session({
      executionHostId: 'runtime:windows-box',
      cwd: '/home/ada/wt/live',
      resumeCommand: "cd '/home/ada/wt/live' && codex resume session-1"
    })

    await expect(dropDeletedRemoteResumeCwd(wsl)).resolves.toBe(wsl)
  })

  it('keeps the recorded folder for an agent that can only resume there', async () => {
    const pathExists = vi.fn().mockResolvedValue(false)
    vi.stubGlobal('window', { api: { fs: { pathExists } } })
    const kimi = session({ agent: 'kimi', executionHostId: 'ssh:server-1', cwd: '/home/ada/wt/x' })

    // Why: kimi-cli 1.52 silently opens a new empty session with the same id from any other folder.
    await expect(dropDeletedRemoteResumeCwd(kimi)).resolves.toBe(kimi)
  })
})

/** A host whose home browses as `flavor`, and on which every other folder is missing. */
function serveHostWithMissingFolders(flavor: 'posix' | 'win32'): void {
  browseServerDir.mockImplementation(async (_environmentId: string, path: string) => {
    if (path === '~') {
      return {
        resolvedPath: flavor === 'win32' ? 'C:\\Users\\ada' : '/home/ada',
        entries: [],
        pathFlavor: flavor
      }
    }
    throw runtimeError(`ENOENT: no such file or directory, stat '${path}'`)
  })
}

function runtimeError(message: string): RuntimeRpcCallError {
  return new RuntimeRpcCallError({
    id: 'req',
    ok: false,
    error: { code: 'runtime_error', message }
  })
}

function stubPreparation(prepareSessionResume: ReturnType<typeof vi.fn>): void {
  vi.stubGlobal('window', { api: { aiVault: { prepareSessionResume } } })
}

function session(overrides: Partial<AiVaultSession> = {}): AiVaultSession {
  return {
    id: 'local:codex:session-1:/tmp/rollout.jsonl',
    executionHostId: 'local',
    agent: 'codex',
    sessionId: 'session-1',
    title: 'Legacy session',
    cwd: '/repo',
    branch: null,
    model: null,
    filePath: '/tmp/rollout.jsonl',
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-07-20T00:00:00.000Z',
    messageCount: 1,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: "codex resume 'session-1'",
    subagent: null,
    ...overrides
  }
}
