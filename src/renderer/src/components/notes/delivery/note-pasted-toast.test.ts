// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import {
  showNotePastedToast,
  showNoteSendResultToast,
  showWaitingNoteRefusalToast
} from './note-pasted-toast'

const { info, dismiss } = vi.hoisted(() => ({
  info: vi.fn((_message: string, _options?: { onDismiss?: () => void }) => 'toast'),
  dismiss: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { info, dismiss } }))
vi.mock('@/components/native-chat/selection-quotes/native-chat-workspace-selection', () => ({
  revealAgentTerminal: vi.fn()
}))

afterEach(() => {
  info.mock.calls.at(-1)?.[1]?.onDismiss?.()
  vi.useRealTimers()
  vi.clearAllMocks()
})

it.each([showNotePastedToast, showWaitingNoteRefusalToast])(
  'offers manual submission only once the full host estimate has settled',
  async (showToast) => {
    vi.useFakeTimers()
    const readyMessage = 'submit-ready marker'
    showToast({
      worktreeId: 'synthetic-workspace',
      target: { kind: 'terminal', tabId: 'tab', leafId: 'leaf' },
      agentLabel: 'Stand-in',
      settleMs: 181_438,
      readyMessage
    })
    const submissionOffered = (): boolean =>
      info.mock.calls.some(([message]) => message === readyMessage)
    expect(submissionOffered()).toBe(false)
    await vi.advanceTimersByTimeAsync(90_000)
    expect(submissionOffered()).toBe(false)
    await vi.runAllTimersAsync()
    expect(submissionOffered()).toBe(true)
  }
)

it('settles a send result in the loading toast: pasted waits, refusal informs, unconfirmed chat closes', () => {
  const terminal = { kind: 'terminal' as const, tabId: 'tab', leafId: 'leaf' }
  const args = { worktreeId: 'synthetic-workspace', agentLabel: 'Stand-in', toastId: 'pending' }
  showNoteSendResultToast({ ...args, target: terminal, result: { status: 'pasted' } })
  expect(info).toHaveBeenLastCalledWith(
    expect.stringContaining('Stand-in'),
    expect.objectContaining({ id: 'pending', duration: Infinity })
  )
  info.mock.calls.at(-1)?.[1]?.onDismiss?.()
  info.mockClear()
  showNoteSendResultToast({ ...args, target: terminal, result: { status: 'no-agent' } })
  expect(info).toHaveBeenCalledWith(expect.any(String), { id: 'pending' })
  info.mockClear()
  showNoteSendResultToast({
    ...args,
    target: { kind: 'structured-session', sessionId: 'session' },
    result: { status: 'unconfirmed' }
  })
  expect(dismiss).toHaveBeenCalledWith('pending')
  expect(info).not.toHaveBeenCalled()
})
