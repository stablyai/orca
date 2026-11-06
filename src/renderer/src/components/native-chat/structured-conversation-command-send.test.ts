import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import type { AgentSessionConversationCommandResult } from '../../../../shared/agent-session/agent-session-conversation-command'
import type { AgentSessionFailureFact } from '../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session/failures/agent-session-failure-words'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../../shared/agent-launch/catalog/tui-agent-display-names'
import { structuredAgentLabel } from '@/lib/agent-session/launch/structured-agent-session-launch-label'
import {
  sendStructuredConversationCommand,
  type StructuredConversationCommandCauses
} from './structured-conversation-command-send'

const NO_CAUSES: StructuredConversationCommandCauses = {
  working: false,
  prompt: false,
  background: false,
  sending: false,
  retry: false
}

const COMPACTION_FAILED: AgentSessionFailureFact = {
  kind: 'compactionFailed',
  detail: { text: 'Context is too short', audience: 'person' }
}

function hostResult(
  command: 'clear' | 'compact',
  failure: AgentSessionFailureFact,
  provider: 'claude' | 'codex' = 'claude'
): AgentSessionConversationCommandResult {
  const words = agentSessionFailureWords(failure, {
    agentName: TUI_AGENT_DISPLAY_NAMES[provider],
    command,
    surface: 'row'
  })
  return { command, state: 'completed', error: words.text, failure: words.failure }
}

afterEach(async () => {
  await i18n.changeLanguage('en')
})

describe('a refusal names what it waits on only while the chat shows it', () => {
  const shown = (cause: keyof StructuredConversationCommandCauses) => ({
    ...NO_CAUSES,
    [cause]: true
  })
  const refusedBy = (
    reason: 'turnActive' | 'messagesUnsettled' | 'promptPending' | 'backgroundTasksRunning'
  ): AgentSessionConversationCommandResult =>
    hostResult('clear', {
      kind: 'commandRefused',
      refusal: { code: 'agent_session_operation_invalid', details: { reason } }
    })
  const hostAnswers = (
    result: AgentSessionConversationCommandResult,
    causes: StructuredConversationCommandCauses
  ) =>
    sendStructuredConversationCommand({
      command: result.command,
      agentName: structuredAgentLabel('claude'),
      pending: { current: false },
      hold: null,
      causes,
      startFailures: () => [],
      send: async () => ({ kind: 'done', value: result })
    })

  it('from the host: the reason its words name, when the chat shows it', async () => {
    for (const reason of ['turnActive', 'messagesUnsettled'] as const) {
      expect((await hostAnswers(refusedBy(reason), shown('working'))).refusedWhile).toBe('working')
    }
    expect((await hostAnswers(refusedBy('promptPending'), shown('prompt'))).refusedWhile).toBe(
      'prompt'
    )
    const background = await hostAnswers(refusedBy('backgroundTasksRunning'), shown('background'))
    expect(background).toEqual({
      accepted: false,
      error:
        'Background tasks are still running. Wait for the background tasks to finish. Run /clear again.',
      refusedWhile: 'background'
    })
    // Ahead of the chat, or a reason that names nothing it shows: said as any failure.
    expect(await hostAnswers(refusedBy('turnActive'), NO_CAUSES)).not.toHaveProperty('refusedWhile')
    expect(
      await hostAnswers(hostResult('compact', COMPACTION_FAILED), shown('working'))
    ).not.toHaveProperty('refusedWhile')
  })
})
