// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultVoiceSettings } from '../../../../../shared/orca-profiles/constants'
import { VoiceChatGptAccountSettings } from './VoiceChatGptAccountSetting'

vi.mock('@/i18n/use-translate', () => ({ useTranslate: () => translate }))
const translate = (_key: string, fallback: string, values?: Record<string, string>) =>
  fallback.replace('{{account}}', values?.account ?? '')
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector({ openSettingsTarget: vi.fn() })
}))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('dictation account selection', () => {
  it('keeps a removed selection until explicitly choosing a host account', async () => {
    vi.stubGlobal('api', undefined)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        speech: {
          getChatGptAccounts: async () => [
            { id: 'personal', label: 'personal@example.test' },
            { id: 'work', label: 'work@example.test' }
          ]
        }
      }
    })
    Element.prototype.scrollIntoView = vi.fn()
    const update = vi.fn()
    render(
      <VoiceChatGptAccountSettings
        voiceSettings={{ ...getDefaultVoiceSettings(), chatGptAccountId: 'deleted' }}
        onUpdateVoiceSettings={update}
      />
    )
    const trigger = screen.getByRole('combobox')
    await waitFor(() => expect(trigger.hasAttribute('disabled')).toBe(false))
    expect(update).not.toHaveBeenCalled()
    expect(trigger.textContent).toContain('deleted')
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    await screen.findByRole('option', { name: 'work@example.test' })
    fireEvent.click(screen.getByRole('option', { name: 'work@example.test' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith({ chatGptAccountId: 'work' }))
  })
})
