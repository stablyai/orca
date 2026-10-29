// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../../shared/constants'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { PluginLanguagePackRegistration } from '../../../../../shared/plugins/artifacts/plugin-language-pack-artifact'
import { languageDisplayName } from '../presentation/plugin-contributions'
import { PluginContributionActionLanguage } from './PluginContributionActionLanguage'

const state = vi.hoisted(
  (): { settings: GlobalSettings | null; updateSettings: ReturnType<typeof vi.fn> } => ({
    settings: null,
    updateSettings: vi.fn().mockResolvedValue(undefined)
  })
)
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
    getState: () => state
  })
}))
vi.mock('sonner', () => ({ toast }))

const pack: PluginLanguagePackRegistration = {
  id: 'plugin:acme.lang/fr',
  resourceLanguage: 'pluginacmelangfr',
  pluginKey: 'acme.lang',
  locale: 'fr',
  catalog: {},
  coverage: 95
}
const name = languageDisplayName('fr')

afterEach(() => {
  cleanup()
  state.settings = null
  state.updateSettings.mockReset().mockResolvedValue(undefined)
  toast.error.mockClear()
})

it('switches to the pack only when asked and offers the way back to the previous language', () => {
  state.settings = { ...getDefaultSettings('/tmp'), uiLanguage: 'en' }
  const view = render(<PluginContributionActionLanguage pack={pack} />)
  expect(state.updateSettings).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: `Switch language to ${name}` }))
  expect(state.updateSettings).toHaveBeenCalledExactlyOnceWith({ uiLanguage: pack.id })

  state.settings = { ...state.settings, uiLanguage: pack.id }
  view.rerender(<PluginContributionActionLanguage pack={pack} />)
  fireEvent.click(screen.getByRole('button', { name: `Switch back from ${name}` }))
  expect(state.updateSettings).toHaveBeenLastCalledWith({ uiLanguage: 'en' })
})

it('falls back to following the system language when nothing was remembered', () => {
  state.settings = { ...getDefaultSettings('/tmp'), uiLanguage: pack.id }
  render(<PluginContributionActionLanguage pack={pack} />)
  fireEvent.click(screen.getByRole('button', { name: `Switch back from ${name}` }))
  expect(state.updateSettings).toHaveBeenCalledExactlyOnceWith({ uiLanguage: 'system' })
})

it('says so when the switch is rejected', async () => {
  state.settings = { ...getDefaultSettings('/tmp'), uiLanguage: 'en' }
  state.updateSettings.mockRejectedValue(new Error('disk full'))
  render(<PluginContributionActionLanguage pack={pack} />)
  fireEvent.click(screen.getByRole('button', { name: `Switch language to ${name}` }))
  await vi.waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith('Could not switch language', {
      description: 'disk full'
    })
  )
})
