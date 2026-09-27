import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTrustPreset } from '../../src/main/agent-trust-presets'
import { AGENT_TRUST_WRITE_DEADLINE_MS } from '../../src/main/agent-trust-write-deadline'
import { runExclusivelyForCodexTrustConfig } from '../../src/main/codex/codex-trust-config-mutation-queue'
import { preflightAgentTrust } from '../../src/renderer/src/lib/agent-trust-preflight'
import { launchAgentSessionContinuation } from '../../src/renderer/src/lib/launch-agent-session-continuation'

type TrustRequest = { preset: AgentTrustPreset; workspacePath: string; connectionId?: string }
const fake = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: TrustRequest) => Promise<void>>(),
  codex: vi.fn(),
  cursor: vi.fn(),
  copilot: vi.fn(),
  antigravity: vi.fn(),
  remote: vi.fn(),
  launch: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ settings: {}, ensureDetectedAgents: async () => ['codex'] }) }
}))
vi.mock('@/lib/launch-agent-in-new-tab', () => ({ launchAgentInNewTab: fake.launch }))
vi.mock('@/lib/agent-catalog', () => ({ getAgentLabel: () => 'Codex' }))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdFromState: () => null }))
vi.mock('@/lib/worktree-runtime-owner', () => ({ getRuntimeEnvironmentIdForWorktree: () => null }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn() } }))
vi.mock('electron', () => ({
  ipcMain: {
    removeHandler: (channel: string) => fake.handlers.delete(channel),
    handle: (channel: string, handler: (event: unknown, args: TrustRequest) => Promise<void>) =>
      fake.handlers.set(channel, handler)
  }
}))
vi.mock('../../src/main/agent-trust-presets', () => ({
  markCodexProjectTrusted: fake.codex,
  markCursorWorkspaceTrusted: fake.cursor,
  markCopilotFolderTrusted: fake.copilot,
  markAntigravityWorkspaceTrusted: fake.antigravity
}))
vi.mock('../../src/main/remote-agent-trust-presets', () => ({
  markRemoteAgentWorkspaceTrusted: fake.remote
}))
import { registerAgentTrustHandlers } from '../../src/main/ipc/agent-trust'

function deferred() {
  let resolve: () => void = () => {}
  let reject: (reason: Error) => void = () => {}
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function invoke(args: TrustRequest): Promise<void> {
  const handler = fake.handlers.get('agentTrust:markTrusted')
  if (!handler) {
    throw new Error('Trust handler missing')
  }
  return handler({}, args)
}
async function flush(): Promise<void> {
  for (let index = 0; index < 12; index++) {
    await Promise.resolve()
  }
}
const workspacePath = join('mock', 'folder workspace')

beforeEach(() => {
  vi.resetAllMocks()
  fake.handlers.clear()
  registerAgentTrustHandlers()
  vi.stubGlobal('window', { api: { agentTrust: { markTrusted: invoke } } })
})
afterEach(() => vi.unstubAllGlobals())

describe('agent trust completion', () => {
  it('holds the actual session-continuation launch call until the local write settles', async () => {
    const write = deferred()
    fake.codex.mockReturnValue(write.promise)
    fake.launch.mockReturnValue({ surface: { kind: 'local-terminal', tabId: 'mock-tab' } })
    const request = launchAgentSessionContinuation({
      agent: 'codex',
      prompt: 'mock continuation',
      worktreeId: 'mock-workspace',
      workspacePath,
      launchSource: 'sidebar'
    })
    await flush()
    const launchesBeforeWrite = fake.launch.mock.calls.length
    write.resolve()
    await expect(request).resolves.toBe(true)
    expect(launchesBeforeWrite).toBe(0)
    expect(fake.launch).toHaveBeenCalledTimes(1)
  })

  it('keeps renderer preflight pending behind the actual config mutation queue', async () => {
    const blocker = deferred()
    const key = join('mock', 'codex', 'config.toml')
    const held = runExclusivelyForCodexTrustConfig(key, () => blocker.promise)
    let writes = 0
    let continuationCalls = 0
    fake.codex.mockImplementation(() =>
      runExclusivelyForCodexTrustConfig(key, async () => {
        writes += 1
      })
    )
    const launch = preflightAgentTrust({ agent: 'codex', workspacePath }).then(() => {
      continuationCalls += 1
    })
    await flush()
    const beforeRelease = { writes, continuationCalls }
    blocker.resolve()
    await held
    await launch
    await flush()
    expect(beforeRelease).toEqual({ writes: 0, continuationCalls: 0 })
    expect(writes).toBe(1)
    expect(continuationCalls).toBe(1)
  })

  it('settles best-effort only after a queued local trust failure', async () => {
    const write = deferred()
    // Keep the original implementation's discarded promise from leaking into the test runner.
    void write.promise.catch(() => {})
    fake.codex.mockReturnValue(write.promise)
    let settled = false
    const request = invoke({ preset: 'codex', workspacePath }).then(() => {
      settled = true
    })
    await flush()
    const beforeFailure = settled
    write.reject(new Error('mock EACCES'))
    await expect(request).resolves.toBeUndefined()
    expect(beforeFailure).toBe(false)
    expect(settled).toBe(true)
  })

  it('contains an immediate local writer rejection', async () => {
    fake.codex.mockRejectedValue(new Error('mock write failed'))
    await expect(invoke({ preset: 'codex', workspacePath })).resolves.toBeUndefined()
    await flush()
  })

  it('bounds a never-settling local write and continues untrusted', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const write = deferred()
    void write.promise.catch(() => {})
    fake.codex.mockReturnValue(write.promise)
    let settled = false
    const request = invoke({ preset: 'codex', workspacePath }).then(() => {
      settled = true
    })
    try {
      await vi.advanceTimersByTimeAsync(AGENT_TRUST_WRITE_DEADLINE_MS - 1)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(2)
      await expect(request).resolves.toBeUndefined()
      expect(settled).toBe(true)
      expect(warn).toHaveBeenCalledOnce()
      expect(String(warn.mock.calls[0]?.[0])).toContain('did not settle')
      // No leaked deadline timer keeps the handler or the process alive.
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      warn.mockRestore()
      write.resolve()
      vi.useRealTimers()
    }
  })

  it('admits an already-complete write without waiting for any timer', async () => {
    vi.useFakeTimers()
    fake.codex.mockResolvedValue(undefined)
    try {
      // No timer is advanced: "already done" must settle on microtasks alone.
      await expect(invoke({ preset: 'codex', workspacePath })).resolves.toBeUndefined()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('absorbs a local rejection that arrives after the deadline', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const write = deferred()
    fake.codex.mockReturnValue(write.promise)
    try {
      const request = invoke({ preset: 'codex', workspacePath })
      await vi.advanceTimersByTimeAsync(AGENT_TRUST_WRITE_DEADLINE_MS + 1)
      await expect(request).resolves.toBeUndefined()
      // Unhandled here would fail the run: the abandoned write is still adopted.
      write.reject(new Error('mock EACCES after deadline'))
      await vi.advanceTimersByTimeAsync(1)
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  it('bounds a never-settling SSH trust write without a local fallback', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const write = deferred()
    void write.promise.catch(() => {})
    fake.remote.mockReturnValue(write.promise)
    try {
      const request = invoke({ preset: 'codex', workspacePath, connectionId: 'ssh-1' })
      await vi.advanceTimersByTimeAsync(AGENT_TRUST_WRITE_DEADLINE_MS + 1)
      await expect(request).resolves.toBeUndefined()
      // Loss of contact is not a verdict: nothing is written locally instead.
      expect(fake.codex).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
      write.resolve()
      vi.useRealTimers()
    }
  })

  it('settles two concurrent launches for the same workspace independently', async () => {
    const first = deferred()
    const second = deferred()
    fake.codex.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const earlier = invoke({ preset: 'codex', workspacePath })
    const later = invoke({ preset: 'codex', workspacePath })
    first.reject(new Error('mock EACCES'))
    await expect(earlier).resolves.toBeUndefined()
    second.resolve()
    await expect(later).resolves.toBeUndefined()
    // Not deduped by design: the writer's upsert is idempotent per workspace.
    expect(fake.codex).toHaveBeenCalledTimes(2)
  })

  it('keeps SSH trust on its remote owner and waits for its result', async () => {
    const write = deferred()
    fake.remote.mockReturnValue(write.promise)
    let settled = false
    const request = invoke({ preset: 'codex', workspacePath, connectionId: ' ssh-1 ' }).then(() => {
      settled = true
    })
    await flush()
    const beforeRemote = settled
    write.resolve()
    await request
    expect(beforeRemote).toBe(false)
    expect(fake.codex).not.toHaveBeenCalled()
    expect(fake.remote).toHaveBeenCalledWith({
      preset: 'codex',
      workspacePath,
      connectionId: 'ssh-1'
    })
  })

  it('keeps remote failures best-effort without a local fallback', async () => {
    fake.remote.mockRejectedValue(new Error('provider unavailable'))
    await expect(
      invoke({ preset: 'codex', workspacePath, connectionId: 'ssh-1' })
    ).resolves.toBeUndefined()
    expect(fake.codex).not.toHaveBeenCalled()
  })

  it.each(['cursor', 'copilot', 'antigravity'] as const)(
    'keeps %s synchronous preset dispatch',
    async (preset) => {
      await invoke({ preset, workspacePath })
      expect(fake[preset]).toHaveBeenCalledExactlyOnceWith(workspacePath)
      expect(fake.codex).not.toHaveBeenCalled()
      expect(fake.remote).not.toHaveBeenCalled()
    }
  )

  it('skips a missing workspace and keeps synchronous failures best-effort', async () => {
    await invoke({ preset: 'codex', workspacePath: '' })
    expect(fake.codex).not.toHaveBeenCalled()
    fake.codex.mockImplementation(() => {
      throw new Error('mock path failure')
    })
    await expect(invoke({ preset: 'codex', workspacePath })).resolves.toBeUndefined()
  })
})
