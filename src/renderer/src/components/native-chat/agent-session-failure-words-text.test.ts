import { afterEach, describe, expect, it, vi } from 'vitest'
import { i18n } from '@/i18n/i18n'
import type * as I18nModule from '@/i18n/i18n'
import {
  readWholeAgentSessionFailureFact,
  type AgentSessionFailureFact
} from '../../../../shared/agent-session-failure'
import { agentSessionFailureSentence } from '../../../../shared/agent-session-failure-words'
import { agentSessionWriteNoticeParts } from '../../../../shared/agent-session-refusal-notice'
import { agentSessionRefusalFailure } from '../../../../shared/agent-session-write-failure'
import { structuredAgentSessionRejectionParts } from '../../../../shared/structured-agent-session-rejection-words'
import { sayAgentSessionFailureTranslated } from './agent-session-failure-words-text'
import { agentSessionWriteNoticeText } from './agent-session-write-notice-text'

vi.mock('@/i18n/i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof I18nModule>()
  return { ...actual, translate: vi.fn(actual.translate) }
})

afterEach(async () => {
  await i18n.changeLanguage('en')
})

describe('desktop words for a failure fact', () => {
  it.each([
    ['en', 'Then send your message again.'],
    ['es', 'Después, envía tu mensaje de nuevo.'],
    ['fr', 'Puis envoyez à nouveau votre message.'],
    ['ja', 'その後、メッセージをもう一度送信してください。'],
    ['ko', '그런 다음 메시지를 다시 보내세요.'],
    ['zh', '然后再次发送消息。']
  ])('keeps %s copy while separating an unpunctuated provider detail', async (locale, retry) => {
    await i18n.changeLanguage(locale)
    const fact = {
      kind: 'notSignedIn',
      detail: { text: 'See {{agent}} docs/models.md', audience: 'person' }
    } as const
    const context = { agentName: 'Pi' }
    const row = agentSessionFailureSentence(fact, 'row', context, sayAgentSessionFailureTranslated)
    expect(row.endsWith(fact.detail.text)).toBe(true)
    expect(
      agentSessionFailureSentence(fact, 'rejection', context, sayAgentSessionFailureTranslated)
    ).toBe(`${row}. ${retry}`)
  })

  it("words a refused start and a rejected message in the reader's language", async () => {
    await i18n.changeLanguage('fr')
    const refused = agentSessionRefusalFailure({
      code: 'agent_session_operation_invalid',
      details: { reason: 'notSignedIn' }
    })
    expect(
      agentSessionWriteNoticeText(
        agentSessionWriteNoticeParts(refused, 'send', { agentName: 'Claude' })
      )
    ).toBe(
      "Votre message n'a pas été envoyé. Claude n’est pas connecté. Exécutez `claude auth login`, ou choisissez un compte dans les paramètres des Comptes Claude."
    )
    const detail = 'Uses {{agent}} $t(components.native-chat.failureWords.theAgent) <b>&</b>'
    const rejected = structuredAgentSessionRejectionParts(
      `Codex didn't accept this message: ${detail}.`,
      'send',
      { kind: 'providerRejected', detail: { text: detail, audience: 'person' } },
      { agentName: 'Codex' }
    )
    // The provider's own words stay as written: placeholders, nesting and markup are not read.
    expect(agentSessionWriteNoticeText(rejected)).toBe(
      `Codex n'a pas accepté ce message : ${detail}.`
    )
    expect(
      agentSessionWriteNoticeText(
        structuredAgentSessionRejectionParts(null, 'send', { kind: 'providerExited' }, {})
      )
    ).toBe("L'agent s'est arrêté avant l'envoi de ce message.")
  })

  it('names the command a failed start was for inside the translated sentence', async () => {
    const sentence = (kind: AgentSessionFailureFact['kind'], command: 'clear' | 'compact') =>
      agentSessionFailureSentence(
        { kind },
        'row',
        { agentName: 'Codex', command },
        sayAgentSessionFailureTranslated
      )
    await i18n.changeLanguage('fr')
    expect(sentence('restartFailed', 'compact')).toBe(
      "Codex n'a pas pu redémarrer. Relancez /compact."
    )
    expect(sentence('notSignedIn', 'clear')).toBe(
      'Codex n’est pas connecté. Exécutez `codex login`. Relancez /clear.'
    )
    await i18n.changeLanguage('ja')
    expect(sentence('providerStartFailed', 'compact')).toBe(
      'Codex は起動が完了する前に停止しました。/compact をもう一度実行してください。'
    )
    expect(sentence('managedAccountUnsupported', 'compact')).toBe(
      'WSL に Claude アカウントが追加されている間、Claude チャットには Windows の Claude アカウントが必要です。Claude アカウントの設定で選択または追加してから、/compact をもう一度実行してください。'
    )
  })

  it("says which request a start ran out of time on in the reader's language", async () => {
    await i18n.changeLanguage('fr')
    expect(
      agentSessionFailureSentence(
        { kind: 'startFailed', requestTimeout: { method: 'thread/start', timeoutMs: 30_000 } },
        'row',
        { agentName: 'Codex', retryControl: true },
        sayAgentSessionFailureTranslated
      )
    ).toBe(
      "Codex a mis trop de temps à démarrer (aucune réponse à thread/start après 30 s). Si cela se reproduit, l'ordinateur qui exécute ce chat est peut-être surchargé."
    )
  })

  it("says a refused command and a refused Stop in the reader's language", async () => {
    await i18n.changeLanguage('fr')
    const sentence = (fact: AgentSessionFailureFact) =>
      agentSessionFailureSentence(
        fact,
        'row',
        { agentName: 'Codex' },
        sayAgentSessionFailureTranslated
      )
    expect(sentence({ kind: 'commandRefused' })).toBe(
      "Cette commande n'a pas été exécutée. Réessayez."
    )
    expect(sentence({ kind: 'stopRefused' })).toBe("Codex n'avait aucun tour en cours à arrêter.")
    expect(
      sentence({
        kind: 'stopRefused',
        detail: { text: 'no active turn to interrupt.', audience: 'person' }
      })
    ).toBe("Codex ne s'est pas arrêté : no active turn to interrupt.")
  })

  it("says an image's size limit in the reader's unit", async () => {
    await i18n.changeLanguage('fr')
    const sentence = (reason: 'tooLarge' | 'totalTooLarge', megabytes: number) =>
      agentSessionFailureSentence(
        { kind: 'attachmentInvalid', attachment: { reason, limit: megabytes * 1024 * 1024 } },
        'rejection',
        {},
        sayAgentSessionFailureTranslated
      )
    expect(sentence('tooLarge', 5)).toBe(
      "Une image de ce message dépasse 5 Mo, le message n'a donc pas été envoyé."
    )
    expect(sentence('totalTooLarge', 20)).toBe(
      "Les images de ce message dépassent 20 Mo au total, le message n'a donc pas été envoyé."
    )
  })

  it('uses the host sentence if the argument detail is newer than this reader', () => {
    const sentence = 'Codex could not start. Edit saved Arguments in Settings > Agents.'
    expect(
      agentSessionWriteNoticeText(
        structuredAgentSessionRejectionParts(
          sentence,
          'send',
          readWholeAgentSessionFailureFact({
            kind: 'startFailed',
            argumentProblem: { agent: 'Codex', option: '--remote', problem: 'futureProblem' }
          })
        )
      )
    ).toBe(sentence)
  })
})
