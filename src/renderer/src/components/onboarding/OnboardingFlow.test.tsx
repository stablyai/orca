import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultOnboardingState, getDefaultSettings } from '../../../../shared/constants'
import { useAppStore } from '@/store'
import OnboardingFlow from './OnboardingFlow'

describe('OnboardingFlow', () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true)
    useAppStore.setState({
      repos: [],
      settings: getDefaultSettings('/tmp')
    })
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
  })

  afterEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true)
    vi.unstubAllGlobals()
  })

  it('renders the tour intro in the standard left-aligned onboarding shell', () => {
    const html = renderToStaticMarkup(
      <OnboardingFlow
        onboarding={{
          ...getDefaultOnboardingState(),
          lastCompletedStep: 5
        }}
        onOnboardingChange={vi.fn()}
      />
    )

    expect(html).toContain('Interested in Orca&#x27;s advanced features?')
    expect(html).toContain('Take a short tour before getting started.')
    expect(html).toContain('Learn how Orca can help you')
    expect(html).toContain('Hand off a feature to an orchestrator agent.')
    expect(html).toContain('Grab an element from your running app and send it to an agent.')
    expect(html).not.toContain('Write and preview Markdown.')
    expect(html).toContain('items-start')
    expect(html).toContain('text-left')
    expect(html).toContain('Continue')
    expect(html).toContain('Skip to project setup')
    expect(html).not.toContain('Skip the tour')
  })
})
