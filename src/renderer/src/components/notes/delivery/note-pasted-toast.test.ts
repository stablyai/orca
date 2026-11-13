// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { showNotePastedToast, showWaitingNoteRefusalToast } from './note-pasted-toast'

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
