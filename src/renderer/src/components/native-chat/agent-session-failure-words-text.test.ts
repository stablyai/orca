import { afterEach, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import { agentSessionFailureSentence } from '../../../../shared/agent-session/failures/agent-session-failure-words'
import { sayAgentSessionFailureTranslated } from './agent-session-failure-words-text'

afterEach(async () => {
  await i18n.changeLanguage('en')
})

it.each([
  [
    'en',
    'OMP has no model selected. Check your model selection and OMP sign-in, then send again.',
    "OMP couldn't use @worker_be. Update OMP to 18.1.9 or later to keep it after a restart, or pick another model and send again."
  ],
  [
    'zh',
    'OMP 没有选择模型。请检查模型选择和 OMP 登录状态，然后重新发送。',
    expect.stringContaining('请将 OMP 更新到 18.1.9 或更高版本')
  ]
] as const)(
  'words a missing OMP model and the update hint on desktop (%s)',
  async (locale, none, update) => {
    await i18n.changeLanguage(locale)
    const say = (fact: Parameters<typeof agentSessionFailureSentence>[0]) =>
      agentSessionFailureSentence(
        fact,
        'rejection',
        { agentName: 'OMP' },
        sayAgentSessionFailureTranslated
      )
    expect(say({ kind: 'modelNotSelected' })).toBe(none)
    expect(
      say({
        kind: 'modelUnavailable',
        detail: { text: '@worker_be', audience: 'log' },
        agentUpdate: '18.1.9'
      })
    ).toEqual(update)
  }
)
