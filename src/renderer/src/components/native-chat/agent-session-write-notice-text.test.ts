import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import en from '@/i18n/locales/en.json'
import {
  AGENT_SESSION_WRITE_NOTICE_COPY,
  agentSessionWriteNoticeEnglish,
  type AgentSessionWriteNoticeSentence
} from '../../../../shared/agent-session-refusal-notice'
import { agentSessionWriteNoticeText } from './agent-session-write-notice-text'

const SENTENCES = Object.keys(AGENT_SESSION_WRITE_NOTICE_COPY).filter(
  (key): key is AgentSessionWriteNoticeSentence => key in AGENT_SESSION_WRITE_NOTICE_COPY
)

afterEach(async () => {
  await i18n.changeLanguage('en')
})

describe('desktop words for a write that did not happen', () => {
  it('says exactly what the phone says in English', () => {
    for (const sentence of SENTENCES) {
      expect(agentSessionWriteNoticeText([sentence])).toBe(
        agentSessionWriteNoticeEnglish([sentence])
      )
    }
  })

  it('keeps the English catalog in step with the shared copy', () => {
    expect(en.components['native-chat'].writeNotice).toEqual(AGENT_SESSION_WRITE_NOTICE_COPY)
  })

  it('translates each sentence whole and shows a provider reason as written', async () => {
    await i18n.changeLanguage('fr')
    expect(agentSessionWriteNoticeText(['restartFailed', 'notDoneSend'])).toBe(
      "L'agent n'a pas pu redémarrer. Votre message n'a pas été envoyé."
    )
    expect(
      agentSessionWriteNoticeText([{ text: 'Claude messages support at most 20 images' }])
    ).toBe('Claude messages support at most 20 images')
  })
})
