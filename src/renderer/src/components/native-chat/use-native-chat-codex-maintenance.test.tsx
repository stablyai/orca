// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useNativeChatCodexMaintenance } from './use-native-chat-codex-maintenance'
import type { AgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import type { QueuedMessageCard } from './structured-agent-session-queued-cards'
import { agentSessionRefusalFailure } from '../../../../shared/agent-session-write-failure'

vi.mock('@/hooks/useCodexMaintenance', () => ({
  useCodexMaintenance: () => ({
    installation: { status: 'ready', version: '0.136.0', minimumVersion: '0.136.0' },
    state: { evidence: { configurationId: 'supported' }, job: null },
    blocked: false,
    notice: null
  })
}))
afterEach(cleanup)

const refusal: AgentSessionFailureFact = {
  kind: 'startFailed',
  refusal: {
    code: 'agent_session_operation_invalid',
    details: { codexInstallation: { installedVersion: '0.135.0', minimumVersion: '0.136.0' } }
  }
}
function input(): Parameters<typeof useNativeChatCodexMaintenance>[0] {
  return {
    agent: 'codex',
    sessionId: 'saved-chat',
    target: { kind: 'local' },
    startFailures: [refusal],
    launch: {
      lifecycle: null,
      failure: null,
      launch: undefined,
      starting: false,
      transportEnabled: true,
      sendThroughLaunch: (_text, _images, send) => send(),
      retry: vi.fn()
    },
    queuedMessages: { cards: [], steer: vi.fn(async () => {}), queueResume: undefined }
  }
}

it.each(['returned', 'paused'] as const)(
  'offers the existing message Send for a %s card and withdraws it when the card goes',
  (hold) => {
    const props = input()
    const card: QueuedMessageCard = {
      messageId: 'retained-draft',
      position: 1,
      text: 'retry this instruction',
      state: hold === 'returned' ? 'returned' : 'waiting',
      hold
    }
    props.queuedMessages.cards = [card]
    const { result, rerender } = renderHook(useNativeChatCodexMaintenance, { initialProps: props })
    expect(props.queuedMessages.steer).not.toHaveBeenCalled()
    expect(props.launch.retry).not.toHaveBeenCalled()
    expect(result.current.notice?.action?.label).toBe('Send')
    act(() => result.current.notice?.action?.onClick())
    expect(props.queuedMessages.steer).toHaveBeenCalledExactlyOnceWith('retained-draft')
    rerender({ ...props, queuedMessages: { ...props.queuedMessages, cards: [] } })
    expect(result.current.notice?.text).toBe('Codex is updated. Send your message again.')
    expect(result.current.notice?.action).toBeUndefined()
  }
)

it('offers Resume only while the queue controller says it can resume', () => {
  const props = input()
  const resume = vi.fn(async () => true)
  props.queuedMessages.queueResume = { resume, resuming: false }
  const { result, rerender } = renderHook(useNativeChatCodexMaintenance, { initialProps: props })
  expect(resume).not.toHaveBeenCalled()
  expect(result.current.notice?.action?.label).toBe('Resume')
  act(() => result.current.notice?.action?.onClick())
  expect(resume).toHaveBeenCalledOnce()
  rerender({ ...props, queuedMessages: { ...props.queuedMessages, queueResume: undefined } })
  expect(result.current.notice?.action).toBeUndefined()
})

it('keeps a retained message on its own Send even when other cards can Resume', () => {
  const props = input()
  const resume = vi.fn(async () => true)
  props.queuedMessages.queueResume = { resume, resuming: false }
  props.queuedMessages.cards = [
    { messageId: 'returned', position: 1, text: 'held', state: 'returned', hold: 'returned' }
  ]
  const { result } = renderHook(() => useNativeChatCodexMaintenance(props))
  expect(result.current.notice?.action?.label).toBe('Send')
  act(() => result.current.notice?.action?.onClick())
  expect(props.queuedMessages.steer).toHaveBeenCalledExactlyOnceWith('returned')
  expect(resume).not.toHaveBeenCalled()
})

it.each(['new', 'resume'] as const)(
  'uses the launch retry for a refused %s request without sending any retained message',
  (kind) => {
    const props = input()
    props.launch.lifecycle = 'failed'
    props.launch.launch = { kind, heldOptions: {} }
    props.launch.failure = agentSessionRefusalFailure({
      code: 'agent_session_operation_invalid',
      details: { codexInstallation: { installedVersion: '0.135.0', minimumVersion: '0.136.0' } }
    })
    props.queuedMessages.cards = [
      { messageId: 'returned', position: 1, text: 'held', state: 'returned', hold: 'returned' }
    ]
    const { result } = renderHook(() => useNativeChatCodexMaintenance(props))
    expect(props.launch.retry).toHaveBeenCalledOnce()
    expect(result.current.notice?.action?.label).toBe('Retry')
    act(() => result.current.notice?.action?.onClick())
    expect(props.launch.retry).toHaveBeenCalledTimes(2)
    expect(props.queuedMessages.steer).not.toHaveBeenCalled()
  }
)
