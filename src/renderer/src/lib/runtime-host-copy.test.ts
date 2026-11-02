import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import es from '@/i18n/locales/es.json'
import { describeRuntimeCompatBlock, getExecutionHostHealthLabel } from './runtime-host-copy'
import { describeRuntimeCompatBlock as describeRuntimeCompatBlockEnglish } from '../../../shared/protocol-compat'

const originalLanguage = i18n.language

afterEach(async () => {
  await i18n.changeLanguage(originalLanguage)
})

describe('runtime host copy', () => {
  it('resolves live labels and compatibility values in the renderer locale', async () => {
    i18n.addResourceBundle('es', 'translation', es)
    await i18n.changeLanguage('es')
    expect(getExecutionHostHealthLabel('blocked', 'access-revoked')).toBe(es.runtime.health.repair)
    expect(getExecutionHostHealthLabel('blocked')).toBe(es.runtime.health.update)
    const verdict = {
      kind: 'blocked',
      reason: 'client-too-old',
      clientProtocolVersion: 2,
      serverProtocolVersion: 4,
      requiredClientProtocolVersion: 3
    } as const
    expect(describeRuntimeCompatBlock(verdict)).toBe(
      es.runtime.compat.clientTooOld
        .replace('{{clientProtocol}}', '2')
        .replace('{{requiredProtocol}}', '3')
    )
    expect(describeRuntimeCompatBlockEnglish(verdict)).toContain('Client protocol 2')
    await i18n.changeLanguage('en')
    expect(getExecutionHostHealthLabel('blocked', 'access-revoked')).toBe('Re-pair needed')
  })
})
