import { afterEach, describe, expect, it, vi } from 'vitest'
import { i18n, translate } from '@/i18n/i18n'
import type * as I18nModule from '@/i18n/i18n'
import en from '@/i18n/locales/en.json'
import zh from '@/i18n/locales/zh.json'
import {
  AGENT_SESSION_ATTACHMENT_PROBLEM_REASONS,
  AGENT_SESSION_FAILURE_KINDS,
  readWholeAgentSessionFailureFact,
  type AgentSessionFailureFact
} from '../../../../shared/agent-session-failure'
import {
  AGENT_SESSION_FAILURE_COPY,
  sayAgentSessionFailureEnglish,
  type AgentSessionFailureCopyId
} from '../../../../shared/agent-session-failure-copy'
import {
  agentSessionFailureSentence,
  type AgentSessionFailureWordsContext
} from '../../../../shared/agent-session-failure-words'
import { AGENT_SESSION_WRITE_NOTICE_COPY } from '../../../../shared/agent-session-write-notice-copy'
import { agentSessionWriteNoticeParts } from '../../../../shared/agent-session-refusal-notice'
import { agentSessionRefusalFailure } from '../../../../shared/agent-session-write-failure'
import { structuredAgentSessionRejectionParts } from '../../../../shared/structured-agent-session-rejection-words'
import { sayAgentSessionFailureTranslated } from './agent-session-failure-words-text'
import { agentSessionWriteNoticeText } from './agent-session-write-notice-text'

vi.mock('@/i18n/i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof I18nModule>()
  return { ...actual, translate: vi.fn(actual.translate) }
})

const IDS = Object.keys(AGENT_SESSION_FAILURE_COPY).filter(
  (id): id is AgentSessionFailureCopyId => id in AGENT_SESSION_FAILURE_COPY
)
// Said by a refusal notice too, so they keep the notice's keys.
const NOTICE_PIECES: readonly AgentSessionFailureCopyId[] = [
  'terminalAgentHoldsChat',
  'quitTerminalAgent',
  'startNewChat',
  'backgroundTasksRunning',
  'waitForBackgroundTasks',
  'agentStarting',
  'waitForStart',
  'agentStillWorking'
]
// Kana, and kanji whose simplified Chinese form differs (続 is 续, 読 is 读, ...).
const JAPANESE_ONLY = /[\u3040-\u30ff続読変済図気帰戻検択転権単圧応対発処実証覧関専]/u
const VALUES = {
  agent: 'Claude',
  loginCommand: 'agent login',
  slashCommand: '/login',
  command: 'compact',
  detail: 'Image type .bmp',
  limit: '20',
  size: '5',
  option: '--remote'
}

function factsFor(kind: AgentSessionFailureFact['kind']): AgentSessionFailureFact[] {
  const facts: AgentSessionFailureFact[] = [
    { kind },
    { kind, detail: { text: 'Context window exceeded.', audience: 'person' } },
    { kind, detail: { text: 'exit 1', audience: 'log' } },
    // Person words with nothing left once trimmed: the sentence says the lead alone.
    { kind, detail: { text: ' ... ', audience: 'person' } },
    { kind, refusal: { code: 'agent_session_conflict', details: { reason: 'claimConflicted' } } },
    { kind, refusal: { code: 'structured_agent_session_unsupported' } },
    { kind, retry: { error: 'rate_limit', status: 429 } }
  ]
  for (const reason of AGENT_SESSION_ATTACHMENT_PROBLEM_REASONS) {
    facts.push({ kind, attachment: { reason } }, { kind, attachment: { reason, limit: 20 } })
  }
  return facts
}

const CONTEXTS: AgentSessionFailureWordsContext[] = [
  {},
  { agentName: 'Codex' },
  { agentName: 'Claude', command: 'clear' },
  { retryControl: true },
  { agentName: 'Claude', command: 'clear', retryControl: true },
  { agentName: 'Codex', command: 'compact' },
  { command: 'compact', retryControl: true }
]

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

  it('has a key for every piece, whose English default is the shared sentence', () => {
    for (const id of IDS) {
      expect([id, sayAgentSessionFailureTranslated(id, VALUES)]).toEqual([
        id,
        sayAgentSessionFailureEnglish(id, VALUES)
      ])
    }
  })

  // The catalog answers first in English, so read the default each key is given directly.
  it('gives each key the shared sentence as its English default', () => {
    for (const id of IDS) {
      vi.mocked(translate).mockClear()
      sayAgentSessionFailureTranslated(id, VALUES)
      const section = NOTICE_PIECES.includes(id) ? 'writeNotice' : 'failureWords'
      expect(vi.mocked(translate).mock.calls.map(([key, fallback]) => [key, fallback])).toEqual([
        [`components.native-chat.${section}.${id}`, AGENT_SESSION_FAILURE_COPY[id]]
      ])
    }
  })

  it('keeps the English catalog in step with the shared copy', () => {
    const own = Object.fromEntries(
      IDS.filter((id) => !NOTICE_PIECES.includes(id)).map((id) => [
        id,
        AGENT_SESSION_FAILURE_COPY[id]
      ])
    )
    expect(en.components['native-chat'].failureWords).toEqual(own)
    for (const id of NOTICE_PIECES) {
      expect(AGENT_SESSION_WRITE_NOTICE_COPY).toHaveProperty(id, AGENT_SESSION_FAILURE_COPY[id])
    }
  })

  it('says every sentence exactly as the host writes it, in English', () => {
    for (const kind of AGENT_SESSION_FAILURE_KINDS) {
      for (const fact of factsFor(kind)) {
        for (const surface of ['row', 'rejection'] as const) {
          for (const context of CONTEXTS) {
            expect(
              agentSessionFailureSentence(fact, surface, context, sayAgentSessionFailureTranslated)
            ).toBe(agentSessionFailureSentence(fact, surface, context))
          }
        }
      }
    }
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
      `The provider did not accept this message: ${detail}.`,
      'send',
      { kind: 'providerRejected', detail: { text: detail, audience: 'person' } },
      { agentName: 'Codex' }
    )
    // The provider's own words stay as written: placeholders, nesting and markup are not read.
    expect(agentSessionWriteNoticeText(rejected)).toBe(
      `Le fournisseur n'a pas accepté ce message : ${detail}.`
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

  it('shows a host sentence with no fact beside it as written', async () => {
    await i18n.changeLanguage('fr')
    expect(
      agentSessionWriteNoticeText(
        structuredAgentSessionRejectionParts('Claude does not support .bmp images', 'send')
      )
    ).toBe('Claude does not support .bmp images')
  })

  it('keeps Japanese-only characters out of the Chinese words', () => {
    const chat = zh.components['native-chat']
    for (const words of Object.values(chat.failureWords)) {
      expect(words).not.toMatch(JAPANESE_ONLY)
    }
  })
})
