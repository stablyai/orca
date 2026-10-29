import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import es from '@/i18n/locales/es.json'
import { parseExtraAgentArgs } from '../../../../shared/automation-extra-agent-args'
import { extraAgentArgsErrorText } from './automation-extra-agent-args-error-copy'

afterEach(async () => {
  await i18n.changeLanguage('en')
})

describe('extraAgentArgsErrorText', () => {
  it('translates a coded parse failure with its values while the wire error stays English', async () => {
    const parsed = parseExtraAgentArgs({ agent: 'claude', extraAgentArgs: '--model' })
    if (parsed.ok) {
      throw new Error('expected a rejection')
    }
    expect(parsed.error).toBe('"--model" needs a value.')
    i18n.addResourceBundle('es', 'translation', es)
    await i18n.changeLanguage('es')
    expect(extraAgentArgsErrorText(parsed)).toBe(
      es.automations.extraAgentArgs.errors.missingValue.replace('{{option}}', '--model')
    )
  })
})
