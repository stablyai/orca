import { beforeEach, describe, expect, it } from 'vitest'
import { UI_LANGUAGE_ENGLISH, UI_LANGUAGE_SPANISH } from '../../../shared/ui-language'
import { i18n, setRendererUiLanguage } from '../i18n/i18n'
import { activeAgentNotesSendFailureMessage } from './active-agent-note-send-result'

const selectedTerminalKey = 'auto.lib.activeAgentNoteSendResult.noAgent.selectedTerminal'
const activeTerminalKey = 'auto.lib.activeAgentNoteSendResult.noAgent.activeTerminal'

describe('active agent note send failure messages', () => {
  beforeEach(async () => {
    await setRendererUiLanguage(UI_LANGUAGE_ENGLISH)
  })

  it('preserves the selected and active English defaults, including code suffixes', () => {
    expect(activeAgentNotesSendFailureMessage('no-agent', { explicitTarget: true })).toBe(
      'No running agent was found in the selected terminal. Start or resume its agent, then send again.'
    )
    expect(activeAgentNotesSendFailureMessage('no-agent')).toBe(
      'No running agent was found in the active terminal. Focus the agent running in this worktree, then send the notes again.'
    )
    expect(
      activeAgentNotesSendFailureMessage('no-agent', { explicitTarget: true, code: 'no-agent' })
    ).toBe(
      'No running agent was found in the selected terminal. Start or resume its agent, then send again. (no-agent)'
    )
  })

  it('uses no-agent translations from the selected UI locale when available', async () => {
    await setRendererUiLanguage(UI_LANGUAGE_SPANISH)
    const originalSpanishCatalog = structuredClone(i18n.getResourceBundle('es', 'translation'))
    i18n.addResource(
      'es',
      'translation',
      selectedTerminalKey,
      'No se encontró ningún agente en la terminal seleccionada.'
    )
    i18n.addResource(
      'es',
      'translation',
      activeTerminalKey,
      'No se encontró ningún agente en la terminal activa.'
    )

    try {
      expect(activeAgentNotesSendFailureMessage('no-agent', { explicitTarget: true })).toBe(
        'No se encontró ningún agente en la terminal seleccionada.'
      )
      expect(activeAgentNotesSendFailureMessage('no-agent')).toBe(
        'No se encontró ningún agente en la terminal activa.'
      )
    } finally {
      i18n.removeResourceBundle('es', 'translation')
      i18n.addResourceBundle('es', 'translation', originalSpanishCatalog, true, true)
      await setRendererUiLanguage(UI_LANGUAGE_ENGLISH)
    }
  })
})
