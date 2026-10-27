// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { ChatSpeechSetting } from './ChatSpeechSetting'

const state = vi.hoisted(() => ({ settingsSearchQuery: '' }))
vi.mock('../../store', () => ({
  useAppStore: (selector: (value: typeof state) => unknown) => selector(state)
}))

afterEach(() => {
  cleanup()
  state.settingsSearchQuery = ''
})

function renderSpeech(overrides: Partial<GlobalSettings> = {}, showEngine = true) {
  const settings = { ...getDefaultSettings('/tmp'), ...overrides }
  const updateSettings = vi.fn()
  render(
    <ChatSpeechSetting
      settings={settings}
      updateSettings={updateSettings}
      showEngine={showEngine}
      forceVisible
    />
  )
  return { updateSettings }
}

describe('Chat speech settings', () => {
  it('turns the speak button off', () => {
    const { updateSettings } = renderSpeech()
    fireEvent.click(screen.getByRole('switch', { name: 'Speak replies' }))
    expect(updateSettings).toHaveBeenCalledWith({ nativeChatSpeech: { enabled: false } })
  })

  it('turns automatic reading on', () => {
    const { updateSettings } = renderSpeech()
    fireEvent.click(screen.getByRole('switch', { name: 'Speak new replies' }))
    expect(updateSettings).toHaveBeenCalledWith({ nativeChatSpeech: { auto: true } })
  })

  it('stores a neural voice that is not the default', () => {
    const { updateSettings } = renderSpeech({ nativeChatSpeech: { engine: 'edge' } })
    fireEvent.click(screen.getByRole('radio', { name: 'Dmitry' }))
    expect(updateSettings).toHaveBeenCalledWith({
      nativeChatSpeech: { engine: 'edge', voice: 'ru-RU-DmitryNeural' }
    })
  })

  it('keeps the neural engine off the web client', () => {
    renderSpeech({}, false)
    expect(screen.queryByRole('radio', { name: 'Neural' })).toBeNull()
  })

  it('disables the other controls while speech is off', () => {
    renderSpeech({ nativeChatSpeech: { enabled: false, engine: 'edge' } })
    expect(
      screen.getByRole('switch', { name: 'Speak new replies' }).hasAttribute('disabled')
    ).toBe(true)
    expect(screen.getByRole('radio', { name: 'Neural' }).getAttribute('aria-disabled')).toBe('true')
  })
})
