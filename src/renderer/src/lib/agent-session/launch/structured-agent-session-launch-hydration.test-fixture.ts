import { startStructuredAgentLaunch } from './structured-agent-session-launch'
import { STRUCTURED_AGENT_SESSION_SUBMISSION_MISSING } from '../../../../../shared/agent-session/requests/structured-agent-session-send-evidence'
import { getStructuredAgentSessionReadOwner } from '@/components/native-chat/session/structured/read/structured-agent-session-read-owner'
import { projectStructuredAgentSessionMessages } from '@/components/native-chat/conversation/projection/structured-agent-session-message-projection'
import { createNativeChatMessageListProjection } from '@/components/native-chat/conversation/projection/native-chat-message-list-projection'
import { agentJournalSubmissionKey } from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { expect, it } from 'vitest'
import { newAgentLaunchRequestId } from './routing/agent-launch-request-id'
import { getStructuredAgentSessionPendingSends } from '@/components/native-chat/session/structured/delivery/structured-agent-session-pending-sends'
import { readStructuredAgentLaunchRecord } from './structured-agent-session-launch-persistence'
import {
  mocks,
  created,
  target,
  createParams
} from './structured-agent-session-launch-create-message.test-fixture'

export function registerCreateHydrationTests(): void {
  it.each(['absent', 'synthetic-missing'] as const)(
    'hydrates chat existence without claiming %s opening proof or replaying it',
    async (proof) => {
      mocks.call.mockImplementation(async (_target, method) => {
        const response = created()
        response.value.page.items = [
          {
            itemId: 'previous-answer',
            revision: 1,
            sequence: 1,
            observedAt: 1,
            body: {
              kind: 'message',
              role: 'assistant',
              blocks: [{ type: 'text', text: 'Earlier answer' }]
            }
          }
        ]
        response.value.page.submissions =
          proof === 'absent'
            ? []
            : response.value.page.submissions.map((row) => ({
                ...row,
                reason: STRUCTURED_AGENT_SESSION_SUBMISSION_MISSING
              }))
        return method === 'agentSession.history'
          ? { ok: true, page: response.value.page }
          : response
      })
      const launch = startStructuredAgentLaunch('workspace-1', 'codex', {
        requestId: newAgentLaunchRequestId(),
        prompt: 'opening text',
        resumeFrom: { providerSessionId: 'provider-session-1' }
      })
      mocks.inventory.mockResolvedValue([
        { worktree: 'workspace-1', tabs: [{ type: 'agent-session', sessionId: launch.sessionId }] }
      ])
      await expect(launch.launchResult).rejects.toThrow('did not confirm its first message')
      await expect(launch.promptDeliveryResult).resolves.toMatchObject({
        delivered: false,
        unconfirmed: true
      })
      expect(
        getStructuredAgentSessionReadOwner(launch.sessionId, target).getSnapshot().state.fence
      ).toBe(1)
      expect(getStructuredAgentSessionPendingSends(launch.sessionId)[0]).toMatchObject({
        phase: 'unconfirmed'
      })
      const state = getStructuredAgentSessionReadOwner(launch.sessionId, target).getSnapshot().state
      const messages = createNativeChatMessageListProjection()(
        projectStructuredAgentSessionMessages(
          state.items,
          getStructuredAgentSessionPendingSends(launch.sessionId),
          state.submissions
        )
      )
      expect(messages.conversation.map(({ id }) => id)).toEqual([
        'previous-answer',
        agentJournalSubmissionKey(createParams().firstMessage?.clientMessageId ?? '')
      ])
      expect(readStructuredAgentLaunchRecord(launch.sessionId)?.firstMessage).toEqual(
        createParams().firstMessage
      )
      expect(mocks.call.mock.calls.map(([, method]) => method)).toEqual([
        'agentSession.create',
        'agentSession.history'
      ])
    }
  )
}
