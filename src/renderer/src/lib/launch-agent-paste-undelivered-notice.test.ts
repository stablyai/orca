// Quick launch is the highest-volume paste entry point, and it used to report every undelivered
// prompt as a readiness timeout — including a credential refusal, which is a different event with
// different advice and different telemetry.
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createPasteUndeliveredNotice } from './launch-agent-paste-undelivered-notice'

const testState = vi.hoisted(() => ({
  appState: {
    activeWorktreeId: 'wt-1',
    tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'pty-1' }] } as Record<
      string,
      { id: string; ptyId: string | null }[]
    >
  },
  toastMessage: vi.fn(),
  track: vi.fn(),
  showCredentialToast: vi.fn()
}))

vi.mock('@/store', () => ({ useAppStore: { getState: () => testState.appState } }))
vi.mock('sonner', () => ({ toast: { message: testState.toastMessage } }))
vi.mock('@/lib/telemetry', () => ({
  track: testState.track,
  tuiAgentToAgentKind: (agent: string) => agent
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/lib/agent-paste-credential-prompt-notice', () => ({
  showAgentPasteCredentialPromptToast: testState.showCredentialToast
}))

function notice(): ReturnType<typeof createPasteUndeliveredNotice> {
  return createPasteUndeliveredNotice({
    worktreeId: 'wt-1',
    tabId: 'tab-1',
    agent: 'codex',
    submitted: true
  })
}

describe('createPasteUndeliveredNotice', () => {
  beforeEach(() => {
    testState.appState.activeWorktreeId = 'wt-1'
    testState.appState.tabsByWorktree = { 'wt-1': [{ id: 'tab-1', ptyId: 'pty-1' }] }
    testState.toastMessage.mockReset()
    testState.track.mockReset()
    testState.showCredentialToast.mockReset()
  })

  it('routes a credential refusal to the credential notice, not the timeout one', () => {
    const undelivered = notice()
    undelivered.onUndelivered('credential-prompt')

    expect(testState.showCredentialToast).toHaveBeenCalledExactlyOnceWith('codex', true)
    expect(testState.track).not.toHaveBeenCalled()
    expect(undelivered.wasNotified()).toBe(true)
  })

  it('still reports a readiness timeout as a readiness timeout', () => {
    const undelivered = notice()
    undelivered.onUndelivered('readiness-timeout')

    expect(testState.showCredentialToast).not.toHaveBeenCalled()
    expect(testState.track).toHaveBeenCalledExactlyOnceWith('agent_error', {
      error_class: 'paste_readiness_timeout',
      agent_kind: 'codex'
    })
    expect(undelivered.wasNotified()).toBe(true)
  })

  it('stays silent when the PTY never spawned, so the caller owns the sole notice', () => {
    testState.appState.tabsByWorktree = { 'wt-1': [{ id: 'tab-1', ptyId: null }] }
    const undelivered = notice()
    undelivered.onUndelivered('credential-prompt')

    expect(testState.showCredentialToast).not.toHaveBeenCalled()
    expect(undelivered.wasNotified()).toBe(false)
  })

  it('suppresses the toast but marks notified once the user has moved on', () => {
    testState.appState.activeWorktreeId = 'wt-2'
    const undelivered = notice()
    undelivered.onUndelivered('credential-prompt')

    expect(testState.showCredentialToast).not.toHaveBeenCalled()
    expect(testState.toastMessage).not.toHaveBeenCalled()
    expect(undelivered.wasNotified()).toBe(true)
  })
})
