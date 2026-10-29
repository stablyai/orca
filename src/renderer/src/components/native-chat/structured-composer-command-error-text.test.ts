import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import es from '@/i18n/locales/es.json'
import { structuredComposerFailure } from '../../../../shared/structured-agent-session-composer-failure'
import { localizeStructuredComposerOutcome } from './structured-composer-command-error-text'

afterEach(async () => {
  await i18n.changeLanguage('en')
})

describe('localizeStructuredComposerOutcome', () => {
  it('translates coded refusals and passes already-worded errors through', async () => {
    i18n.addResourceBundle('es', 'translation', es)
    await i18n.changeLanguage('es')
    const coded = {
      handled: true,
      accepted: false,
      ...structuredComposerFailure('commandTakesNoArguments', { name: 'clear' })
    }
    expect(coded.error).toBe('Use /clear without arguments.')
    expect(localizeStructuredComposerOutcome(coded).error).toBe(
      es.components['native-chat'].composerErrors.commandTakesNoArguments.replace(
        '{{name}}',
        'clear'
      )
    )
    const host = { handled: true, accepted: false, error: 'Host refusal.' }
    expect(localizeStructuredComposerOutcome(host)).toBe(host)
  })
})
