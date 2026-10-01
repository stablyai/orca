import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import type { AgentSessionConversationCommandResult } from '../../../../shared/agent-session-conversation-command'
import type { AgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session-failure-words'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../../shared/tui-agent-display-names'
import { structuredAgentLabel } from '@/lib/structured-agent-session-launch-label'
import { sendStructuredConversationCommand } from './structured-conversation-command-send'

const START_FAILED: AgentSessionFailureFact = { kind: 'startFailed' }
const COMPACTION_FAILED: AgentSessionFailureFact = {
  kind: 'compactionFailed',
  detail: { text: 'Context is too short', audience: 'person' }
}

// The facts a command whose conversation did not start can carry: a /clear's new one, or the
// start a /compact waited on.
const START_FACTS: AgentSessionFailureFact[] = [
  START_FAILED,
  { kind: 'restartFailed' },
  { kind: 'startFailed', refusal: { code: 'structured_agent_session_unsupported' } },
  {
    kind: 'startFailed',
    refusal: { code: 'agent_session_conflict', details: { reason: 'claimConflicted' } }
  },
  { kind: 'providerStartFailed' },
  { kind: 'notSignedIn' },
  { kind: 'historyTooLarge' },
  { kind: 'managedAccountUnsupported' },
  { kind: 'managedAccountEnvOverride' },
  { kind: 'accountSwitchInProgress' }
]
const COMPACT_FACTS: AgentSessionFailureFact[] = [
  COMPACTION_FAILED,
  { kind: 'commandRefused' },
  { kind: 'compactionFailed' },
  { kind: 'compactionUnconfirmed' }
]

// What the host returns: its English, worded with the context it uses, beside the fact.
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

async function sent(
  result: AgentSessionConversationCommandResult,
  provider: 'claude' | 'codex' = 'claude'
) {
  return sendStructuredConversationCommand({
    command: result.command,
    agentName: structuredAgentLabel(provider),
    pending: { current: false },
    blocked: false,
    startFailures: () => [],
    send: async () => ({ kind: 'done', value: result })
  })
}

afterEach(async () => {
  await i18n.changeLanguage('en')
})

describe('the line under the composer after a conversation command failed', () => {
  it('says in English exactly what the host wrote, for every failure a command reports', async () => {
    for (const provider of ['claude', 'codex'] as const) {
      for (const result of [
        ...START_FACTS.map((fact) => hostResult('clear', fact, provider)),
        ...START_FACTS.map((fact) => hostResult('compact', fact, provider)),
        ...COMPACT_FACTS.map((fact) => hostResult('compact', fact, provider))
      ]) {
        expect(await sent(result, provider)).toEqual({ accepted: false, error: result.error })
      }
    }
    // The host's own tests pin these sentences.
    expect((await sent(hostResult('clear', START_FAILED, 'codex'), 'codex')).error).toBe(
      "Codex couldn't start. Run /clear again."
    )
    expect(
      (await sent(hostResult('compact', { kind: 'restartFailed' }, 'codex'), 'codex')).error
    ).toBe("Codex couldn't restart. Run /compact again.")
    expect((await sent(hostResult('compact', { kind: 'notSignedIn' }), 'claude')).error).toBe(
      'Claude is not signed in for the selected account. Sign in, then run /compact again.'
    )
    expect((await sent(hostResult('clear', START_FACTS[2], 'codex'), 'codex')).error).toBe(
      "Codex couldn't start. Start a new chat to continue."
    )
    expect((await sent(hostResult('clear', { kind: 'notSignedIn' }, 'codex'), 'codex')).error).toBe(
      'Codex is not signed in for the selected account. Sign in, then run /clear again.'
    )
  })

  it("says it in the reader's language", async () => {
    await i18n.changeLanguage('fr')
    expect((await sent(hostResult('clear', START_FAILED))).error).toBe(
      "Claude n'a pas pu démarrer. Relancez /clear."
    )
    expect((await sent(hostResult('compact', COMPACTION_FAILED))).error).toBe(
      'La compaction a échoué : Context is too short.'
    )
    expect((await sent(hostResult('compact', { kind: 'restartFailed' }))).error).toBe(
      "Claude n'a pas pu redémarrer. Relancez /compact."
    )
    expect((await sent(hostResult('compact', { kind: 'managedAccountUnsupported' }))).error).toBe(
      "Tant qu'un compte Claude est ajouté dans WSL, les chats Claude nécessitent un compte Claude Windows. Choisissez-en un ou ajoutez-en un dans les paramètres Comptes Claude, puis relancez /compact."
    )
    await i18n.changeLanguage('ja')
    expect((await sent(hostResult('clear', START_FAILED))).error).toBe(
      'Claude を起動できませんでした。/clear をもう一度実行してください。'
    )
    expect((await sent(hostResult('compact', { kind: 'notSignedIn' }))).error).toBe(
      'Claude は選択したアカウントでサインインしていません。サインインしてから、/compact をもう一度実行してください。'
    )
  })

  it("shows the host's sentence as written when this build cannot read all of its fact", async () => {
    await i18n.changeLanguage('fr')
    const error = "Claude couldn't start. Start a new chat to continue."
    // As a newer host sends them: a refusal code, a refusal reason, and a part this build doesn't know.
    for (const failure of [
      JSON.parse('{ "kind": "startFailed", "refusal": { "code": "agent_session_newer_refusal" } }'),
      JSON.parse(
        '{ "kind": "startFailed", "refusal": { "code": "agent_session_conflict", "details": { "reason": "newerReason" } } }'
      ),
      JSON.parse('{ "kind": "startFailed", "newerPart": { "reason": "unresumable" } }')
    ]) {
      expect(await sent({ command: 'clear', state: 'completed', error, failure })).toEqual({
        accepted: false,
        error
      })
    }
    expect((await sent(hostResult('clear', START_FACTS[2]))).error).toBe(
      "Claude n'a pas pu démarrer. Démarrez un nouveau chat pour continuer."
    )
  })

  it("shows the host's sentence as written for a command this build doesn't know", async () => {
    await i18n.changeLanguage('fr')
    const error = "Claude couldn't start. Run /rewind again."
    // A newer host's command, with a fact this build reads whole and a loaded row stating it.
    const result: AgentSessionConversationCommandResult = JSON.parse(
      `{ "command": "rewind", "state": "completed", "error": ${JSON.stringify(error)}, "failure": { "kind": "startFailed" } }`
    )
    expect(
      await sendStructuredConversationCommand({
        command: 'compact',
        agentName: 'Claude',
        pending: { current: false },
        blocked: false,
        startFailures: () => [START_FAILED],
        send: async () => ({ kind: 'done', value: result })
      })
    ).toEqual({ accepted: false, error })
  })

  it("shows an older host's sentence as written when it sent no fact", async () => {
    await i18n.changeLanguage('fr')
    expect(
      await sent({
        command: 'clear',
        state: 'completed',
        error: "Claude couldn't start. Run /clear again."
      })
    ).toEqual({ accepted: false, error: "Claude couldn't start. Run /clear again." })
    expect(await sent({ command: 'compact', state: 'completed' })).toEqual({
      accepted: true,
      error: null
    })
  })
})
