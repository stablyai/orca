// EP-6-FLAKE: a slow open says so after a few seconds; a timeout says it is still starting (Try
// again); a workspace the server no longer has fails at once (Couldn't find it).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toast = vi.hoisted(() => ({
  loading: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  dismiss: vi.fn()
}))
vi.mock('sonner', () => ({ toast }))

import {
  OPEN_FEEDBACK_DELAY_MS,
  beginCloudWorkspaceOpenFeedback,
  endCloudWorkspaceOpenFeedback,
  resetCloudWorkspaceOpenFeedbackForTests,
  showCloudWorkspaceOpenInPicker
} from './cloud-workspace-open-feedback'
import { openFailureKind } from './open-cloud-workspace'

const actions = { retry: vi.fn(), showWorkspaces: vi.fn() }

beforeEach(() => {
  vi.useFakeTimers()
  for (const fn of Object.values(toast)) {
    fn.mockReset()
  }
})
afterEach(() => {
  resetCloudWorkspaceOpenFeedbackForTests()
  vi.useRealTimers()
})

describe('cloud workspace open feedback', () => {
  it('a quick open shows nothing', () => {
    beginCloudWorkspaceOpenFeedback('ws', 'web')
    vi.advanceTimersByTime(OPEN_FEEDBACK_DELAY_MS - 1)
    expect(endCloudWorkspaceOpenFeedback('ws', { ok: true }, actions)).toBe(false)
    vi.advanceTimersByTime(OPEN_FEEDBACK_DELAY_MS)
    expect(toast.loading).not.toHaveBeenCalled()
    expect(toast.dismiss).not.toHaveBeenCalled()
  })

  it('a slow open says so after the delay, and the toast closes when it opens', () => {
    beginCloudWorkspaceOpenFeedback('ws', 'web')
    vi.advanceTimersByTime(OPEN_FEEDBACK_DELAY_MS)
    expect(toast.loading).toHaveBeenCalledWith('Opening web…', expect.anything())
    endCloudWorkspaceOpenFeedback('ws', { ok: true }, actions)
    expect(toast.dismiss).toHaveBeenCalledWith('cloud-workspace-open:ws')
  })

  it('a timeout is a warning with Try again, and the caller shows nothing more', () => {
    beginCloudWorkspaceOpenFeedback('ws', 'web')
    vi.advanceTimersByTime(OPEN_FEEDBACK_DELAY_MS)
    expect(endCloudWorkspaceOpenFeedback('ws', { ok: false, failure: 'timeout' }, actions)).toBe(
      true
    )
    const [title, options] = toast.warning.mock.calls[0]!
    expect(title).toBe('web is taking longer than usual')
    expect(options.action.label).toBe('Try again')
    options.action.onClick()
    expect(actions.retry).toHaveBeenCalled()
  })

  it('a workspace that is gone fails at once with Show cloud workspaces', () => {
    beginCloudWorkspaceOpenFeedback('ws', 'web')
    expect(endCloudWorkspaceOpenFeedback('ws', { ok: false, failure: 'gone' }, actions)).toBe(true)
    const [title, options] = toast.error.mock.calls[0]!
    expect(title).toBe('Couldn’t find web')
    expect(options.action.label).toBe('Show cloud workspaces')
  })

  it('any other failure leaves the message to the caller', () => {
    beginCloudWorkspaceOpenFeedback('ws', 'web')
    expect(endCloudWorkspaceOpenFeedback('ws', { ok: false }, actions)).toBe(false)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('waits while the picker shows the open, and shows at once when the picker closes', () => {
    beginCloudWorkspaceOpenFeedback('ws', 'web')
    const release = showCloudWorkspaceOpenInPicker('ws')
    vi.advanceTimersByTime(OPEN_FEEDBACK_DELAY_MS * 2)
    expect(toast.loading).not.toHaveBeenCalled()
    release()
    expect(toast.loading).toHaveBeenCalledTimes(1)
  })

  it('the picker closing before the delay shows it at once too, without restarting the wait', () => {
    beginCloudWorkspaceOpenFeedback('ws', 'web')
    const release = showCloudWorkspaceOpenInPicker('ws')
    vi.advanceTimersByTime(1_000)
    release()
    expect(toast.loading).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(OPEN_FEEDBACK_DELAY_MS)
    expect(toast.loading).toHaveBeenCalledTimes(1)
  })

  it('classifies a grant or wake refusal: timeout is still starting, not_found is gone', () => {
    expect(openFailureKind('timeout')).toBe('timeout')
    expect(openFailureKind('not_found')).toBe('gone')
    expect(openFailureKind('entitlement_denied')).toBeUndefined()
    expect(openFailureKind(undefined)).toBeUndefined()
  })
})
