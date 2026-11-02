// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  mocks,
  resetCreateMessageFixture,
  cleanupCreateMessageFixture,
  deferred,
  draft
} from '../../structured-agent-session-launch-create-message.test-fixture'
import { startStructuredAgentLaunch } from './structured-agent-session-launch'
import {
  getStructuredAgentSessionLaunchFailure,
  getStructuredAgentSessionLaunchLifecycle
} from './structured-agent-session-launch-registry'
import { newAgentLaunchRequestId } from '../../agent-launch-request-id'
import { getStructuredAgentSessionSendNotice } from '@/components/native-chat/structured-agent-session-pending-sends'
import { structuredSessionNotices } from '@/components/native-chat/native-chat-structured-session-notices'
import { requiredSetupLaunchFailureText } from '@/lib/required-setup-launch-failure'

let restore: (() => void) | undefined
beforeEach(() => {
  restore = resetCreateMessageFixture()
})
afterEach(() => cleanupCreateMessageFixture(restore))

it.each([
  ['runs past 30 seconds', 31_000],
  ['fails at once', 0]
])(
  'explains a required Setup refusal that %s, keeping the opening message',
  async (_case, setupMs) => {
    const reply = deferred<unknown>()
    mocks.call.mockReturnValue(reply.promise)
    const launch = startStructuredAgentLaunch('workspace-1', 'codex', {
      requestId: newAgentLaunchRequestId(),
      executionHostId: 'local',
      prompt: 'Inspect the failing test and fix it',
      afterWorktreeSetup: true
    })
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(setupMs)
    // Setup still running is no reason to doubt delivery or hand the message back.
    expect(getStructuredAgentSessionLaunchLifecycle('workspace-1', launch.sessionId)).toBe(
      'pending'
    )
    expect(getStructuredAgentSessionSendNotice(launch.sessionId)).toBeNull()
    reply.resolve({
      ok: false,
      refusal: {
        code: 'agent_session_setup_not_completed',
        message:
          'Setup failed, so Codex was not started. Fix setup, then start Codex in this workspace.'
      }
    })
    await expect(launch.launchResult).rejects.toThrow('Setup failed')
    await vi.advanceTimersByTimeAsync(1)
    const lifecycle = getStructuredAgentSessionLaunchLifecycle('workspace-1', launch.sessionId)
    expect(lifecycle).toBe('failed')
    expect(draft(launch.sessionId)).toBe('Inspect the failing test and fix it')
    const notices = structuredSessionNotices({
      launch: {
        lifecycle,
        failure: getStructuredAgentSessionLaunchFailure('workspace-1', launch.sessionId),
        retry: () => {}
      },
      agentLabel: 'Codex',
      sessionError: getStructuredAgentSessionSendNotice(launch.sessionId),
      composerError: null
    })
    expect(notices.map((notice) => notice.text)).toEqual([requiredSetupLaunchFailureText('Codex')])
  }
)
