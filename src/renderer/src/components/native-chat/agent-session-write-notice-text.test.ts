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
    const catalog: Record<string, string> = {
      ...en.components['native-chat'].writeNotice,
      // The Retry row's long-standing wording keeps its existing key.
      messageNotSent: en.auto.components.native.chat.NativeChatStructuredSession['93ef441197']
    }
    for (const sentence of SENTENCES) {
      expect(catalog[sentence]).toBe(AGENT_SESSION_WRITE_NOTICE_COPY[sentence])
    }
  })

  it('translates each sentence whole and shows a provider reason as written', async () => {
    await i18n.changeLanguage('fr')
    expect(agentSessionWriteNoticeText(['notDoneSend', 'tryAgainSend'])).toBe(
      "Votre message n'a pas été envoyé. Cliquez sur Réessayer pour le renvoyer."
    )
    expect(
      agentSessionWriteNoticeText([{ text: 'Claude messages support at most 20 images' }])
    ).toBe('Claude messages support at most 20 images')
  })
})
