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

  it('does not render the removed agent setup or tour steps', () => {
    const html = renderToStaticMarkup(
      <OnboardingFlow
        onboarding={{
          ...getDefaultOnboardingState(),
          lastCompletedStep: 3
        }}
        onOnboardingChange={vi.fn()}
      />
    )

    expect(html).toContain('Set up GitHub tasks')
    expect(html).not.toContain('Set up Orca for agents')
    expect(html).not.toContain('Explore Orca')
    expect(html).not.toContain('Take the tour')
    expect(html).toContain('Continue')
    expect(html).toContain('Skip to project setup')
  })

  it.each([
    [4, 'Set up GitHub tasks'],
    [5, 'Point Orca at some code'],
    [6, 'Point Orca at some code'],
    [9, 'Point Orca at some code']
  ])(
    'resumes legacy onboarding progress %i at the matching five-step page',
    (legacyStep, title) => {
      const html = renderToStaticMarkup(
        <OnboardingFlow
          onboarding={{
            ...getDefaultOnboardingState(),
            flowVersion: 1,
            lastCompletedStep: legacyStep
          }}
          onOnboardingChange={vi.fn()}
        />
      )

      expect(html).toContain(title)
      expect(html).not.toContain('Set up Orca for agents')
      expect(html).not.toContain('Explore Orca')
    }
  )

  it('skips GitHub task setup when the GitHub CLI is already detected', () => {
    useAppStore.setState({
      preflightStatus: {
        git: { installed: true },
        gh: { installed: true, authenticated: false }
      },
      preflightStatusChecked: true
    })

    const html = renderToStaticMarkup(
      <OnboardingFlow
        onboarding={{
          ...getDefaultOnboardingState(),
          lastCompletedStep: 3
        }}
        onOnboardingChange={vi.fn()}
      />
    )

    expect(html).toContain('Point Orca at some code')
    expect(html).not.toContain('Set up GitHub tasks')
    expect(html).not.toContain('Connect your task sources')
  })

  it('shows only GitHub on the task setup page when the GitHub CLI is missing', () => {
    useAppStore.setState({
      preflightStatus: {
        git: { installed: true },
        gh: { installed: false, authenticated: false }
      },
      preflightStatusChecked: true
    })

    const html = renderToStaticMarkup(
      <OnboardingFlow
        onboarding={{
          ...getDefaultOnboardingState(),
          lastCompletedStep: 3
        }}
        onOnboardingChange={vi.fn()}
      />
    )

    expect(html).toContain('Set up GitHub tasks')
    expect(html).toContain('Install the GitHub CLI to:')
    expect(html).toContain('GitHub')
    expect(html).not.toContain(
      '<h3 class="text-[15px] font-semibold leading-tight text-foreground">Linear</h3>'
    )
    expect(html).toContain(
      'Linear, GitLab, Bitbucket, Azure DevOps, Gitea, and Jira live in Settings'
    )
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
