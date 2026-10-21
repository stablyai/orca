import { afterEach, expect, it, vi } from 'vitest'
import {
  prepareNativeChatCliFork,
  type NativeChatCliForkSubject
} from './native-chat-cli-fork-preparation'
import { AI_VAULT_CHAT_FORK_SOURCE_CAPABILITY } from '../../../shared/ai-vault-resume-preparation'

const { call } = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: call }))
afterEach(() => {
  call.mockReset()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
const subject: NativeChatCliForkSubject = {
  kind: 'chat',
  sessionId: 'chat-1',
  workspaceId: 'workspace-1',
  request: { executionHostScope: 'runtime:peer', scopePaths: ['/host/repo'], sessionLimit: 250 }
}
const source = {
  agent: 'claude',
  sourceAgent: 'claude',
  sessionId: 'provider-1',
  filePath: '/host/saved.jsonl',
  cwd: '/host/repo',
  codexHome: null,
  executionHostPlatform: 'linux'
}
const options = { pairingRevision: 7, isCurrent: () => true, signal: new AbortController().signal }
const delayed = <T>(value: T, ms: number) =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value), ms))

it('negotiates then prepares on the same paired host without requesting History', async () => {
  call
    .mockResolvedValueOnce({ capabilities: [AI_VAULT_CHAT_FORK_SOURCE_CAPABILITY] })
    .mockResolvedValueOnce({ useRealCodexHome: false, cliForkSource: source })
  await expect(prepareNativeChatCliFork(subject, options)).resolves.toMatchObject({
    session: { sessionId: 'provider-1', executionHostId: 'runtime:peer' },
    copied: false
  })
  expect(call.mock.calls.map((args) => args[1])).toEqual([
    'status.get',
    'aiVault.prepareSessionResume'
  ])
  expect(call.mock.calls[1]).toEqual([
    { kind: 'environment', environmentId: 'peer' },
    'aiVault.prepareSessionResume',
    {
      sourceChat: { sessionId: 'chat-1', workspaceId: 'workspace-1' },
      executionHostId: 'runtime:peer',
      fork: true
    },
    expect.objectContaining({ expectedEnvironmentPairingRevision: 7 })
  ])
})

it('does not retry History after a capable host refuses or returns a malformed source', async () => {
  for (const result of [
    () => Promise.reject(new Error('Cannot read saved conversation')),
    () => Promise.resolve({ useRealCodexHome: false })
  ]) {
    call
      .mockResolvedValueOnce({ capabilities: [AI_VAULT_CHAT_FORK_SOURCE_CAPABILITY] })
      .mockImplementationOnce(result)
    await expect(prepareNativeChatCliFork(subject, options)).rejects.toThrow()
  }
  expect(call.mock.calls.some((args) => args[1] === 'aiVault.listSessions')).toBe(false)
})

it('asks an old peer for one bounded same-host list and does not scan twice when absent', async () => {
  call
    .mockResolvedValueOnce({ capabilities: [] })
    .mockResolvedValueOnce({ sessions: [], issues: [], scannedAt: 'now' })
  await expect(prepareNativeChatCliFork(subject, options)).rejects.toThrow('no saved conversation')
  expect(call.mock.calls.map((args) => args[1])).toEqual(['status.get', 'aiVault.listSessions'])
  expect(call.mock.calls[1]?.[2]).toMatchObject({
    executionHostId: 'runtime:peer',
    force: undefined
  })
  expect(call.mock.calls[1]?.[3]).toMatchObject({
    expectedEnvironmentPairingRevision: 7,
    timeoutMs: 150_000
  })
})

it('does not prepare when the source retires during capability admission', async () => {
  let current = true
  call.mockImplementationOnce(async () => {
    current = false
    return { capabilities: [AI_VAULT_CHAT_FORK_SOURCE_CAPABILITY] }
  })
  await expect(
    prepareNativeChatCliFork(subject, { ...options, isCurrent: () => current })
  ).rejects.toThrow('source chat changed')
  expect(call).toHaveBeenCalledTimes(1)
})

it.each([true, false])(
  'preserves delayed modern=%s preparation within its phase budgets',
  async (modern) => {
    vi.useFakeTimers()
    call.mockResolvedValueOnce({
      capabilities: modern ? [AI_VAULT_CHAT_FORK_SOURCE_CAPABILITY] : []
    })
    if (!modern) {
      const row = {
        ...source,
        agent: 'codex',
        codexHome: '/host/codex-runtime-home/home',
        executionHostId: 'runtime:peer',
        messageCount: 1,
        queuedMessageCount: 0,
        structuredSession: { sessionId: 'chat-1', workspaceId: 'workspace-1' }
      }
      call.mockImplementationOnce(() => delayed({ sessions: [row] }, 45_000))
    }
    call.mockImplementationOnce(() =>
      delayed({ useRealCodexHome: false, cliForkSource: source }, 40_000)
    )
    const result = prepareNativeChatCliFork(subject, options)
    await vi.advanceTimersByTimeAsync(modern ? 40_000 : 85_000)
    await expect(result).resolves.toMatchObject({ session: { sessionId: 'provider-1' } })
    expect(vi.getTimerCount()).toBe(0)
  }
)

it('bounds legacy inventory observation at 150 seconds and revokes its queued signal', async () => {
  vi.useFakeTimers()
  call
    .mockResolvedValueOnce({ capabilities: [] })
    .mockImplementationOnce(() => new Promise(() => {}))
  const failed = expect(prepareNativeChatCliFork(subject, options)).rejects.toThrow('timed out')
  await vi.advanceTimersByTimeAsync(150_000)
  await failed
  expect(call.mock.calls[1]?.[3].signal.aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})
