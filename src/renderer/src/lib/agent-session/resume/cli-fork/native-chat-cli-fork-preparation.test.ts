import { afterEach, expect, it, vi } from 'vitest'
import {
  prepareNativeChatCliFork,
  type NativeChatCliForkSubject
} from './native-chat-cli-fork-preparation'
import { AI_VAULT_CHAT_FORK_SOURCE_CAPABILITY } from '../../../../../../shared/ai-vault/resume/ai-vault-resume-preparation'

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
