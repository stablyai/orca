// @vitest-environment happy-dom
import { act, useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { detectUiLanguage, setRendererLanguageDetection } from '../../../../shared/ui-locale'
import { useAppStore } from '@/store'
import { i18n } from '@/i18n/i18n'
import * as rendererI18n from '@/i18n/i18n'
import { useLanguageReadiness } from '@/i18n/language-readiness'
import { I18nProvider } from '@/i18n/I18nProvider'
import * as languageReadiness from '@/i18n/language-readiness'
import { usePluginLanguagePackStore } from '@/store/plugin-language-packs'
import { OnboardingLanguageSwitcher } from './OnboardingLanguageSwitcher'

const { submit, telemetryTrack } = vi.hoisted(() => ({ submit: vi.fn(), telemetryTrack: vi.fn() }))

beforeEach(async () => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({ settings: getDefaultSettings('/tmp') })
  useLanguageReadiness.setState({ ...useLanguageReadiness.getInitialState(), ready: true })
  usePluginLanguagePackStore.setState({ entries: [], loaded: true })
  vi.spyOn(languageReadiness, 'initializeLanguageDetection').mockResolvedValue(
    detectUiLanguage(['it-IT'], 'native')
  )
  setRendererLanguageDetection(detectUiLanguage(['it-IT'], 'native'))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { feedback: { submit }, telemetryTrack }
  })
  submit.mockReset()
  telemetryTrack.mockReset().mockResolvedValue(undefined)
  await i18n.changeLanguage('en')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function openRequest(): Promise<void> {
  render(<OnboardingLanguageSwitcher open onOpenChange={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Other language…' }))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '  Deutsch  ' } })
}

describe('onboarding language request', () => {
  it.each(['control', 'treatment'] as const)('gates the picker for the %s cohort', (cohort) => {
    useAppStore.setState({
      settings: {
        ...getDefaultSettings('/tmp'),
        telemetry: {
          optedIn: true,
          installId: 'test-install',
          existedBeforeTelemetryRelease: false,
          onboardingLanguageCohort: cohort
        }
      }
    })
    render(<OnboardingLanguageSwitcher open={false} onOpenChange={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Switch language' }) !== null).toBe(
      cohort === 'treatment'
    )
  })

  it('acknowledges only delivered feedback, disables duplicate sends and preserves language', async () => {
    let finish: (value: { ok: true }) => void = () => {}
    submit.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    await openRequest()
    fireEvent.click(screen.getByRole('button', { name: 'Request language' }))
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('button', { name: 'Request language' }).hasAttribute('disabled')).toBe(
      true
    )
    expect(submit).toHaveBeenCalledWith({
      feedback: 'Language request: Deutsch',
      submitAnonymously: true,
      githubLogin: null,
      githubEmail: null
    })
    await act(async () => finish({ ok: true }))
    expect(screen.getByRole('status').textContent).toContain('recorded')
    expect(useAppStore.getState().settings?.uiLanguage).toBe('system')
    expect(telemetryTrack).toHaveBeenCalledWith(
      'onboarding_language_requested',
      expect.not.objectContaining({ requested_language: expect.anything() })
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'deutsch' } })
    fireEvent.click(screen.getByRole('button', { name: 'Request language' }))
    expect(submit).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status').textContent).toContain('recorded')
  })

  it('retains a failed draft and retries without claiming success', async () => {
    submit
      .mockResolvedValueOnce({ ok: false, status: null, error: 'Offline' })
      .mockResolvedValueOnce({ ok: true })
    await openRequest()
    fireEvent.click(screen.getByRole('button', { name: 'Request language' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Could not record'))
    expect(screen.queryByRole('status')).toBeNull()
    expect(telemetryTrack).not.toHaveBeenCalledWith(
      'onboarding_language_requested',
      expect.anything()
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('recorded'))
    expect(submit).toHaveBeenCalledTimes(2)
  })

  it('allows language selection after leaving a pending request and still prevents duplicate requests', async () => {
    let finishRequest: (value: { ok: true }) => void = () => {}
    submit.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishRequest = resolve
        })
    )
    let settings = getDefaultSettings('/tmp')
    const save = vi.fn(async (updates: Partial<GlobalSettings>) => {
      settings = { ...settings, ...updates }
      return settings
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { feedback: { submit }, telemetryTrack, settings: { set: save } }
    })
    await openRequest()
    fireEvent.click(screen.getByRole('button', { name: 'Request language' }))
    fireEvent.click(screen.getByRole('button', { name: 'Languages' }))

    expect(screen.getByRole('radiogroup').getAttribute('aria-disabled')).toBe('false')
    fireEvent.click(screen.getByRole('radio', { name: 'Français' }))

    await waitFor(() =>
      expect(screen.getByRole('radio', { name: 'Français' }).getAttribute('data-state')).toBe(
        'checked'
      )
    )
    expect(useAppStore.getState().settings?.uiLanguage).toBe('fr')
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Other language…' }).hasAttribute('disabled')).toBe(
        false
      )
    )
    fireEvent.click(screen.getByRole('button', { name: 'Other language…' }))
    const form = screen.getByRole('textbox').closest('form')
    if (!form) {
      throw new Error('Request form missing')
    }
    fireEvent.submit(form)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('status')).toBeNull()
    await act(async () => finishRequest({ ok: true }))
    expect(screen.getByRole('status').textContent).toContain('recorded')
  })

  it('rejects empty and oversized input before transport', async () => {
    await openRequest()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: ' ' } })
    const form = screen.getByRole('textbox').closest('form')
    if (!form) {
      throw new Error('Request form missing')
    }
    fireEvent.submit(form)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'x'.repeat(81) } })
    fireEvent.submit(form)
    expect(submit).not.toHaveBeenCalled()
  })

  it('freezes switcher eligibility after selecting English', async () => {
    const save = vi.fn(async () => {
      const settings = useAppStore.getState().settings
      if (settings) {
        useAppStore.setState({ settings: { ...settings, uiLanguage: 'en' } })
      }
    })
    useAppStore.setState({ updateSettingsOrThrow: save })
    render(<OnboardingLanguageSwitcher open onOpenChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('radio', { name: 'English' }))
    await waitFor(() => expect(save).toHaveBeenCalledWith({ uiLanguage: 'en' }))
    expect(screen.getByRole('button', { name: 'Switch language' })).toBeTruthy()
  })

  it('lets an open picker close after late native English detection removes its eligibility', async () => {
    useLanguageReadiness.setState({ detection: detectUiLanguage(['en-US'], 'browser-fallback') })
    const onOpenChange = vi.fn()
    function Picker(): React.JSX.Element {
      const [open, setOpen] = useState(false)
      return (
        <OnboardingLanguageSwitcher
          open={open}
          onOpenChange={(next) => {
            setOpen(next)
            onOpenChange(next)
          }}
        />
      )
    }
    const user = userEvent.setup()
    render(<Picker />)
    await user.click(screen.getByRole('button', { name: 'Switch language' }))
    await act(async () => {
      useLanguageReadiness.setState({ detection: detectUiLanguage(['en-US'], 'native') })
    })

    expect(screen.getByRole('radiogroup')).toBeTruthy()
    await user.keyboard('{Escape}')

    expect(onOpenChange).toHaveBeenLastCalledWith(false)
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Switch language' })).toBeNull()
  })
  it('keeps the previous selection and offers retry when persistence fails', async () => {
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error('Disk unavailable'))
      .mockImplementationOnce(async () => {
        const settings = useAppStore.getState().settings
        if (settings) {
          useAppStore.setState({ settings: { ...settings, uiLanguage: 'fr' } })
        }
      })
    const onOpenChange = vi.fn()
    useAppStore.setState({ updateSettingsOrThrow: save })
    render(
      <I18nProvider>
        <OnboardingLanguageSwitcher open onOpenChange={onOpenChange} />
      </I18nProvider>
    )
    await waitFor(() => expect(useLanguageReadiness.getState().loading).toBe(false))
    fireEvent.click(screen.getByRole('radio', { name: 'Français' }))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(
        'Could not save your language preference'
      )
    )
    expect(useAppStore.getState().settings?.uiLanguage).toBe('system')
    expect(screen.getByRole('radio', { name: 'English' }).getAttribute('data-state')).toBe(
      'checked'
    )
    expect(telemetryTrack).not.toHaveBeenCalledWith(
      'onboarding_language_changed',
      expect.anything()
    )
    expect(onOpenChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(i18n.language).toBe('fr'))
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(save).toHaveBeenNthCalledWith(2, { uiLanguage: 'fr' })
    expect(i18n.language).toBe('fr')
    expect(telemetryTrack).toHaveBeenCalledWith(
      'onboarding_language_changed',
      expect.objectContaining({ selected_language: 'fr', effective_language: 'fr' })
    )
  })

  it('guards rapid choices while saving, preserves keyboard focus, and closes on Escape', async () => {
    let finishSave: () => void = () => {}
    const save = vi.fn<ReturnType<typeof useAppStore.getState>['updateSettingsOrThrow']>(
      async (change) => {
        await new Promise<void>((resolve) => {
          finishSave = resolve
        })
        const settings = useAppStore.getState().settings
        if (settings && (change.uiLanguage === 'zh' || change.uiLanguage === 'zh-Hant')) {
          useAppStore.setState({ settings: { ...settings, uiLanguage: change.uiLanguage } })
        }
      }
    )
    useAppStore.setState({ updateSettingsOrThrow: save })
    function Picker(): React.JSX.Element {
      const [open, setOpen] = useState(false)
      return <OnboardingLanguageSwitcher open={open} onOpenChange={setOpen} />
    }
    const user = userEvent.setup()
    render(<Picker />)
    const trigger = screen.getByRole('button', { name: 'Switch language' })
    await user.click(trigger)
    const english = screen.getByRole('radio', { name: 'English' })
    await waitFor(() => expect(document.activeElement).toBe(english))

    for (const name of ['中文（简体）', '繁體中文（台灣）']) {
      await user.keyboard('{ArrowDown>}')
      const radio = screen.getByRole('radio', { name })
      await waitFor(() => expect(save).toHaveBeenCalledTimes(name === '中文（简体）' ? 1 : 2))
      await user.keyboard('{/ArrowDown}')
      expect(document.activeElement).toBe(radio)
      expect(radio.hasAttribute('disabled')).toBe(false)
      expect(screen.getByRole('radiogroup').getAttribute('aria-disabled')).toBe('true')
      expect(screen.getByRole('status').textContent).toContain('Saving language')
      await user.keyboard('{ArrowDown}')
      expect(document.activeElement).toBe(radio)
      expect(save).toHaveBeenCalledTimes(name === '中文（简体）' ? 1 : 2)
      await act(async () => finishSave())
      await waitFor(() => expect(radio.getAttribute('data-state')).toBe('checked'))
      expect(radio.hasAttribute('disabled')).toBe(false)
      expect(document.activeElement).toBe(radio)
      expect(trigger.getAttribute('aria-expanded')).toBe('true')
    }

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('radiogroup')).toBeNull())
    expect(document.activeElement).toBe(trigger)
    expect(useAppStore.getState().settings?.uiLanguage).toBe('zh-Hant')
  })

  it('uses detection only as a hint and saves only explicit built-in selections', async () => {
    setRendererLanguageDetection(detectUiLanguage(['fr-FR'], 'native'))
    const save = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState({ updateSettingsOrThrow: save })
    render(<OnboardingLanguageSwitcher open onOpenChange={vi.fn()} />)
    expect(screen.getByRole('radio', { name: 'Français' }).getAttribute('data-state')).toBe(
      'checked'
    )
    expect(screen.getAllByRole('radio')).toHaveLength(11)
    expect(screen.getByRole('radio', { name: 'Русский' })).toBeTruthy()
    expect(save).not.toHaveBeenCalled()
    expect(useAppStore.getState().settings?.uiLanguage).toBe('system')
    fireEvent.click(screen.getByRole('radio', { name: 'English' }))
    await waitFor(() => expect(save).toHaveBeenCalledWith({ uiLanguage: 'en' }))
  })

  it('keeps unsupported-system copy accurate after a manual non-English choice', async () => {
    useAppStore.setState({ settings: { ...getDefaultSettings('/tmp'), uiLanguage: 'fr' } })
    render(<OnboardingLanguageSwitcher open onOpenChange={vi.fn()} />)
    expect(
      screen.getByText('System language: it-IT. This language is not supported yet.')
    ).toBeTruthy()
    expect(screen.queryByText(/Orca uses English/)).toBeNull()
    expect(screen.getByRole('radio', { name: 'Français' }).getAttribute('data-state')).toBe(
      'checked'
    )
  })

  it('uses the newer authoritative setting when a delayed picker save resolves', async () => {
    const settings = { ...getDefaultSettings('/tmp'), uiLanguage: 'en' as const }
    const newerSettings = { ...settings, uiLanguage: 'ja' as const }
    useAppStore.setState({ settings })
    let finishSave: (value: typeof newerSettings) => void = () => {}
    const save = vi.fn(
      () =>
        new Promise<typeof newerSettings>((resolve) => {
          finishSave = resolve
        })
    )
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { feedback: { submit }, telemetryTrack, settings: { set: save } }
    })
    render(
      <I18nProvider>
        <OnboardingLanguageSwitcher open onOpenChange={vi.fn()} />
      </I18nProvider>
    )
    await waitFor(() => expect(useLanguageReadiness.getState().loading).toBe(false))
    fireEvent.click(screen.getByRole('radio', { name: 'Français' }))
    await waitFor(() => expect(save).toHaveBeenCalledWith({ uiLanguage: 'fr' }))
    await act(async () => useAppStore.setState({ settings: newerSettings }))
    await waitFor(() => expect(i18n.language).toBe('ja'))

    await act(async () => finishSave(newerSettings))

    expect(useAppStore.getState().settings?.uiLanguage).toBe('ja')
    expect(i18n.language).toBe('ja')
    expect(screen.getByRole('radio', { name: '日本語' }).getAttribute('data-state')).toBe('checked')
    expect(telemetryTrack).not.toHaveBeenCalledWith(
      'onboarding_language_changed',
      expect.objectContaining({ selected_language: 'fr' })
    )
  })

  it.each(['fr', 'system'] as const)(
    'retries the saved %s preference without writing settings',
    async (uiLanguage) => {
      setRendererLanguageDetection(detectUiLanguage(['fr-FR'], 'native'))
      const settings = { ...getDefaultSettings('/tmp'), uiLanguage }
      useAppStore.setState({ settings })
      let finishLoad: (locale: string) => void = () => {}
      vi.spyOn(rendererI18n, 'loadRendererUiLanguage')
        .mockRejectedValueOnce(new Error('Offline'))
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishLoad = resolve
            })
        )
      const save = vi.fn()
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: {
          feedback: { submit },
          telemetryTrack,
          settings: { set: save }
        }
      })
      render(
        <I18nProvider>
          <OnboardingLanguageSwitcher open onOpenChange={vi.fn()} />
        </I18nProvider>
      )
      await waitFor(() => expect(useLanguageReadiness.getState().error).toBe(true))
      expect(i18n.language).toBe('en')

      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

      await waitFor(() => expect(useLanguageReadiness.getState().loading).toBe(true))
      expect(screen.getByRole('button', { name: 'Retry' }).hasAttribute('disabled')).toBe(true)
      expect(screen.getByRole('status').textContent).toContain('Loading language')
      expect(screen.getByRole('radio', { name: 'Français' })).toBeTruthy()
      expect(useLanguageReadiness.getState().ready).toBe(true)
      await act(async () => finishLoad('fr'))
      await waitFor(() => expect(i18n.language).toBe('fr'))
      expect(useLanguageReadiness.getState().error).toBe(false)
      expect(useAppStore.getState().settings?.uiLanguage).toBe(uiLanguage)
      expect(screen.queryByRole('alert')).toBeNull()
      expect(save).not.toHaveBeenCalled()
      expect(telemetryTrack).not.toHaveBeenCalledWith(
        'onboarding_language_changed',
        expect.anything()
      )
    }
  )

  it('keeps the saved preference when an explicit selection cannot load its catalog', async () => {
    const save = vi.fn()
    useAppStore.setState({ updateSettingsOrThrow: save })
    vi.spyOn(rendererI18n, 'loadRendererUiLanguage').mockRejectedValue(new Error('Offline'))
    render(<OnboardingLanguageSwitcher open onOpenChange={vi.fn()} />)

    fireEvent.click(screen.getByRole('radio', { name: 'Français' }))

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Could not load this language')
    )
    expect(useAppStore.getState().settings?.uiLanguage).toBe('system')
    expect(save).not.toHaveBeenCalled()
    expect(screen.getByRole('radio', { name: 'English' }).getAttribute('data-state')).toBe(
      'checked'
    )
  })

  it('omits unavailable language requests when using the actual web adapter', async () => {
    const { installWebPreloadApi } = await import('@/web/web-preload-api')
    const originalPath = window.location.href
    window.history.replaceState(null, '', '/web-index.html')
    try {
      Object.defineProperty(window, 'api', {
        configurable: true,
        writable: true,
        value: window.api
      })
      installWebPreloadApi()
      render(<OnboardingLanguageSwitcher open onOpenChange={vi.fn()} />)
      expect(screen.getAllByRole('radio')).toHaveLength(11)
      expect(screen.queryByRole('button', { name: 'Other language…' })).toBeNull()
      expect(screen.queryByRole('textbox')).toBeNull()
    } finally {
      window.history.replaceState(null, '', originalPath)
      Reflect.deleteProperty(window, '__ORCA_WEB_CLIENT__')
    }
  })

  it('does not offer or retry a saved plugin language', async () => {
    useAppStore.setState({
      settings: { ...getDefaultSettings('/tmp'), uiLanguage: 'plugin:example.missing/de' }
    })
    const save = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState({ updateSettingsOrThrow: save })
    render(<OnboardingLanguageSwitcher open onOpenChange={vi.fn()} />)
    expect(screen.getAllByRole('radio')).toHaveLength(11)
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(save).not.toHaveBeenCalled()
  })
})
