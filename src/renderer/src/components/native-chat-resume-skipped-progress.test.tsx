// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi, type Mock } from 'vitest'
import {
  createResumeModalFixture,
  failure,
  type RestartRpc,
  type ResumeStatusStream
} from './native-chat-resume-modal.test-support'
import { NativeChatResumeOnRestartModal } from './NativeChatResumeRuntimeModal'
import { NativeChatResumeStatusSegment } from './status-bar/NativeChatResumeStatusSegment'
import { requestNativeChatResumeOnRestartDialog } from './native-chat-resume-on-restart-dialog'
import { getNativeChatRestartRun } from './native-chat-resume-on-restart-store'

const rpc: Mock<RestartRpc> = vi.hoisted(() => vi.fn<RestartRpc>())
const statusStream: ResumeStatusStream = vi.hoisted(() => ({
  emit: (_event: Parameters<ResumeStatusStream['emit']>[0]) => {},
  snapshot: new Map()
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: rpc,
  subscribeStructuredAgentSessionStatus: async (
    _target: unknown,
    emit: ResumeStatusStream['emit']
  ) => {
    statusStream.emit = emit
    emit({ type: 'snapshot', sessions: [...statusStream.snapshot.values()] })
    return { unsubscribe: () => {} }
  }
}))
vi.mock('@/lib/activate-ai-vault-structured-session', () => ({
  activateAiVaultStructuredSession: vi.fn(async () => true)
}))
vi.mock('sonner', async () =>
  (await import('./native-chat-resume-sonner-mock.test-support')).resumeSonnerMock()
)

const { mount, button, fakeHost } = createResumeModalFixture(rpc, statusStream)
const dialog = () => document.querySelector('[role="dialog"]')?.textContent

it('retires an all-skipped retry after its open result is closed', async () => {
  fakeHost(
    { sessions: [], failed: [{ ...failure('a', 'agent_session_conflict'), retryable: true }] },
    () => 'skipped'
  )
  await mount(
    <>
      <NativeChatResumeOnRestartModal />
      <NativeChatResumeStatusSegment iconOnly={false} />
    </>
  )
  await act(async () => requestNativeChatResumeOnRestartDialog())
  await act(async () => button('Retry').click())
  expect(dialog()).toContain('Resumed 0 of 0 chats')
  expect(getNativeChatRestartRun()?.entries).toHaveLength(0)
  await act(async () => button('Close').click())
  expect(getNativeChatRestartRun()).toBeNull()
  await act(async () => button('1 chat failed to resume').click())
  expect(dialog()).toContain('Resume interrupted chats?')
  expect(dialog()).toContain('Prompt a')
  expect(dialog()).not.toContain('Resumed 0 of 0 chats')
})
