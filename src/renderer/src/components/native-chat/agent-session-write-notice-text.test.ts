import { afterEach, describe, expect, it } from 'vitest'
import { i18n, setRendererPluginLanguagePacks } from '@/i18n/i18n'

import { pluginLanguageResourceId } from '../../../../shared/plugins/plugin-language-pack-artifact'

import {
  agentSessionWriteFailureText,
  agentSessionWriteNoticeText
} from './agent-session-write-notice-text'

afterEach(async () => {
  setRendererPluginLanguagePacks([])
  await i18n.changeLanguage('en')
})

describe('desktop words for a write that did not happen', () => {
  it('does not promise the old goal survived a refused replacement, including older translations', async () => {
    for (const language of ['en', 'fr']) {
      await i18n.changeLanguage(language)
      expect(
        agentSessionWriteFailureText(
          {
            kind: 'refused',
            code: 'agent_session_operation_invalid',
            details: { reason: 'providerRejected' }
          },
          'goal'
        )
      ).toContain("Couldn't finish changing the goal. Check the chat.")
    }
  })

  it("runs on after a plugin language's full stop, and keeps the space after English it left", async () => {
    const id = 'plugin:example.chinese/zh-TW' as const
    setRendererPluginLanguagePacks([
      {
        id,
        resourceLanguage: pluginLanguageResourceId(id),
        pluginKey: 'example.chinese',
        locale: 'zh-TW',
        catalog: {
          components: {
            'native-chat': {
              writeNotice: {
                restartFailed: '智能體無法重新啟動。',
                notDoneSend: '您的訊息未傳送。'
              }
            }
          }
        }
      }
    ])
    await i18n.changeLanguage(pluginLanguageResourceId(id))
    expect(agentSessionWriteNoticeText(['restartFailed', 'notDoneSend'])).toBe(
      '智能體無法重新啟動。您的訊息未傳送。'
    )
    // The pack predates the failure words, so they fall back to English.
    expect(
      agentSessionWriteNoticeText([
        'notDoneSend',
        { failure: { kind: 'startFailed' }, surface: 'rejection', context: { agentName: 'Claude' } }
      ])
    ).toBe("您的訊息未傳送。Claude couldn't start. Send your message to try again.")
  })
})
