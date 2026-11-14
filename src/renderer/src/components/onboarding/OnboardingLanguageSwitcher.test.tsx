// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { detectUiLanguage } from '../../../../shared/ui-locale'
import { useAppStore } from '@/store'
import { i18n } from '@/i18n/i18n'
import { useLanguageReadiness } from '@/i18n/language-readiness'
import { OnboardingLanguageSwitcher } from './OnboardingLanguageSwitcher'

beforeEach(async () => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useLanguageReadiness.setState({ ...useLanguageReadiness.getInitialState(), ready: true })
  await i18n.changeLanguage('en')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('onboarding language switcher eligibility', () => {
  it('shows the picker for a non-English locale with existing settings', () => {
    useAppStore.setState({
      settings: {
        ...getDefaultSettings('/tmp'),
        telemetry: {
          optedIn: true,
          installId: 'test-install',
          existedBeforeTelemetryRelease: false,
          onboardingLanguageCohort: 'control'
        }
      }
    })
    useLanguageReadiness.setState({ detection: detectUiLanguage(['de-DE'], 'native') })
    render(<OnboardingLanguageSwitcher open={false} onOpenChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Switch language' })).toBeTruthy()
  })

  it('keeps the normal English gate and exposes recovery when the catalog fails', () => {
    useAppStore.setState({ settings: getDefaultSettings('/tmp') })
    useLanguageReadiness.setState({ detection: detectUiLanguage(['en-US'], 'native') })
    const { rerender } = render(<OnboardingLanguageSwitcher open={false} onOpenChange={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Switch language' })).toBeNull()

    useLanguageReadiness.setState({ error: true })
    rerender(<OnboardingLanguageSwitcher open={false} onOpenChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Switch language' })).toBeTruthy()
  })
})
