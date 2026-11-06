import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import es from '@/i18n/locales/es.json'
import { keybindingFileDiagnostic } from '../../../../../shared/keybindings/keybinding-diagnostic-copy'
import { keybindingDiagnosticText } from './keybinding-diagnostic-text'

const originalLanguage = i18n.language

afterEach(async () => {
  await i18n.changeLanguage(originalLanguage)
})

describe('keybinding diagnostic text', () => {
  it('keeps verbatim reasons and falls back to the English message', async () => {
    i18n.addResourceBundle('es', 'translation', es)
    await i18n.changeLanguage('es')
    const readFailed = keybindingFileDiagnostic({ severity: 'error' }, 'readFailed', {
      reason: 'Unexpected token } in JSON'
    })
    expect(keybindingDiagnosticText(readFailed)).toBe(
      es.settings.shortcuts.diagnostics.readFailed.replace(
        '{{reason}}',
        'Unexpected token } in JSON'
      )
    )
    const conflict = keybindingFileDiagnostic(
      { severity: 'error', actionIds: ['view.tasks'] },
      'conflictingOverrides',
      { actions: 'Open Tasks' }
    )
    expect(keybindingDiagnosticText(conflict)).toBe(
      es.settings.shortcuts.diagnostics.conflictingOverrides.replace(
        '{{actions}}',
        es.keybindings.title.viewTasks
      )
    )
    expect(keybindingDiagnosticText({ severity: 'error', message: 'Old main text' })).toBe(
      'Old main text'
    )
    expect(
      keybindingDiagnosticText({ severity: 'error', message: 'Newer', code: 'futureCode' })
    ).toBe('Newer')
    expect(
      keybindingDiagnosticText({ severity: 'error', message: 'English', code: 'unknownAction' })
    ).toBe('English')
  })
})
