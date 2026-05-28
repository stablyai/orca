import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultOnboardingState, getDefaultSettings } from '../../../../shared/constants'
import { useAppStore } from '@/store'
import OnboardingFlow from './OnboardingFlow'
import { ONBOARDING_SKIP_CONFIRMATION_COPY } from './OnboardingSkipConfirmationDialog'

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

    expect(html).toContain('Explore Orca')
    expect(html).toContain('Take a 60-second tour of Orca&#x27;s advanced features.')
    expect(html).toContain('Take the tour')
    // Why: the prior intro carried a redundant lead, a four-item checklist, and
    // a help-menu footnote. The tour animation already conveys all of that, so
    // the body is now just the preview + a single CTA — guard against drift.
    expect(html).not.toContain('Preview the core workflow.')
    expect(html).not.toContain('Run agents in isolated worktrees.')
    expect(html).not.toContain('Available later under Help')
    expect(html).toContain('Continue')
    expect(html).toContain('Skip to project setup')
    expect(html).not.toContain('Skip the tour')
  })

  it('keeps agent setup actions out of the footer', () => {
    const html = renderToStaticMarkup(
      <OnboardingFlow
        onboarding={{
          ...getDefaultOnboardingState(),
          lastCompletedStep: 3
        }}
        onOnboardingChange={vi.fn()}
      />
    )

    expect(html).toContain('Set up Orca for agents')
    expect(html).toContain('Turn on advanced Orca capabilities for agents.')
    expect(html).toContain('Enable capabilities')
    expect(html).toContain('Continue')
    expect(html).toContain('Skip to project setup')
    expect(html).not.toContain('>Skip</button>')
  })

  it('renders onboarding inside a centered modal shell', () => {
    const html = renderToStaticMarkup(
      <OnboardingFlow onboarding={getDefaultOnboardingState()} onOnboardingChange={vi.fn()} />
    )

    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('data-onboarding-modal="true"')
    expect(html).toContain('h-[calc(100vh-2rem)]')
    expect(html).toContain('rounded-xl')
    expect(html).toContain('h-7 w-auto shrink-0 invert dark:invert-0')
    expect(html).not.toContain('min-h-screen')
    expect(html).not.toContain('background-color:#12181e')
  })

  it('renders concise skip confirmation copy', () => {
    expect(ONBOARDING_SKIP_CONFIRMATION_COPY).toEqual({
      title: 'Skip onboarding?',
      description: "It won't take long!",
      skipLabel: 'Skip',
      keepGoingLabel: 'No, keep going'
    })
  })
})
