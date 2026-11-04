// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { toast } from 'sonner'
import { useOnboardingFlow } from './use-onboarding-flow'
import type { ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { getDefaultSettings } from '../../../../shared/constants'
import { getDefaultOnboardingState } from '../../../../shared/onboarding-defaults'
import { useAppStore } from '@/store'
import type * as AppStoreModule from '@/store'
import OnboardingFlow from './OnboardingFlow'
import { i18n } from '@/i18n/i18n'
import deCatalog from '@/i18n/locales/de.json'
import { getRepoMainWorktreeId } from '../../../../shared/worktree/id'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'

// Static rendering reads the current test snapshot without mounting app services.
vi.mock('@/store', async (importOriginal) => {
  const actual = await importOriginal<typeof AppStoreModule>()
  return {
    ...actual,
    useAppStore: Object.assign(
      (selector: (state: ReturnType<typeof actual.useAppStore.getState>) => unknown) =>
        selector(actual.useAppStore.getState()),
      actual.useAppStore
    )
  }
})

vi.mock('@/components/terminal-pane/TerminalPane', () => ({
  default: () => {
    throw new Error('This suite must not render a terminal pane')
  }
}))

function renderOnboardingFlow(props: ComponentProps<typeof OnboardingFlow>): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <OnboardingFlow {...props} />
    </TooltipProvider>
  )
}

describe('OnboardingFlow', () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true)
    useAppStore.setState({
      repos: [],
      settings: getDefaultSettings('/tmp')
    })
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
  })

  afterEach(async () => {
    cleanup()
    vi.restoreAllMocks()
    await i18n.changeLanguage('en')
    useAppStore.setState(useAppStore.getInitialState(), true)
    vi.unstubAllGlobals()
  })

  it('keeps onboarding open when the real settings action cannot acknowledge completion', async () => {
    const saveSettings = vi.fn().mockRejectedValue(new Error('settings write failed'))
    const saveProgress = vi.fn().mockResolvedValue(getDefaultOnboardingState())
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        settings: { set: saveSettings },
        onboarding: { update: saveProgress },
        starNag: { onboardingCompleted: vi.fn() }
      }
    })
    const notify = vi.spyOn(toast, 'error').mockImplementation(() => 'notice')
    const openModal = vi.fn()
    useAppStore.setState({
      settings: { ...getDefaultSettings('/tmp'), defaultTuiAgent: 'claude' },
      refreshDetectedAgents: vi.fn().mockResolvedValue(['claude']),
      refreshPreflightStatus: vi.fn().mockResolvedValue(undefined),
      openModal
    })
    const onOnboardingChange = vi.fn()
    const { result } = renderHook(() =>
      useOnboardingFlow(
        {
          ...getDefaultOnboardingState(),
          lastCompletedStep: 4
        },
        onOnboardingChange
      )
    )
    await act(() => result.current.next())
    expect(saveSettings).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ defaultTuiAgent: 'claude' })
    )
    expect(saveProgress).not.toHaveBeenCalled()
    expect(onOnboardingChange).not.toHaveBeenCalled()
    expect(openModal).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledExactlyOnceWith('Could not save progress')
  })

  it('opens on the Chat or Terminal choice and resumes past both step-1 pages', () => {
    const fresh = renderOnboardingFlow({
      onboarding: getDefaultOnboardingState(),
      onOnboardingChange: vi.fn()
    })
    expect(fresh).toContain('How do you want to work with agents?')
    expect(fresh).toContain('1 of 5')

    const resumed = renderOnboardingFlow({
      onboarding: { ...getDefaultOnboardingState(), lastCompletedStep: 1 },
      onOnboardingChange: vi.fn()
    })
    expect(resumed).toContain('Make it feel like home')
  })

  it('does not render the removed agent setup or tour steps', () => {
    const html = renderOnboardingFlow({
      onboarding: {
        ...getDefaultOnboardingState(),
        lastCompletedStep: 3
      },
      onOnboardingChange: vi.fn()
    })

    expect(html).toContain('Set up notifications')
    expect(html).not.toContain('Set up Orca for agents')
    expect(html).not.toContain('Explore Orca')
    expect(html).not.toContain('Take the tour')
    expect(html).toContain('Add your first project')
    expect(html).not.toContain('Point Orca at some code')
  })

  it('offers Continue into the selected folder workspace, including translated onboarding', async () => {
    const repo = {
      id: 'home',
      path: '/tmp/home',
      displayName: 'Home',
      kind: 'folder' as const,
      addedAt: 1,
      badgeColor: 'blue'
    }
    const id = getRepoMainWorktreeId(repo)
    useAppStore.setState({
      repos: [repo],
      activeWorktreeId: id,
      worktreesByRepo: { [repo.id]: [makeWorktree({ id, repoId: repo.id, path: repo.path })] }
    })
    const props = {
      onboarding: { ...getDefaultOnboardingState(), lastCompletedStep: 4 },
      onOnboardingChange: vi.fn()
    }
    expect(renderOnboardingFlow(props)).not.toContain('Add your first project')
    expect(renderOnboardingFlow(props)).toContain('Continue')
    i18n.addResourceBundle('de', 'translation', deCatalog, true, true)
    await i18n.changeLanguage('de')
    expect(renderOnboardingFlow(props)).toContain('Fortfahren')
    expect(renderOnboardingFlow(props)).not.toContain('Add your first project')
  })

  it.each([
    [3, 'Set up GitHub tasks'],
    [4, 'Set up GitHub tasks'],
    [5, 'Set up notifications'],
    [9, 'Set up notifications']
  ])(
    'resumes unversioned seven-step onboarding progress %i at the matching current page',
    (legacyStep, title) => {
      const html = renderOnboardingFlow({
        onboarding: {
          ...getDefaultOnboardingState(),
          flowVersion: 1,
          lastCompletedStep: legacyStep
        },
        onOnboardingChange: vi.fn()
      })

      expect(html).toContain(title)
      expect(html).not.toContain('Set up Orca for agents')
      expect(html).not.toContain('Explore Orca')
    }
  )

  it.each([
    [3, 'Set up GitHub tasks'],
    [4, 'Set up notifications'],
    [5, 'Set up notifications'],
    [9, 'Set up notifications']
  ])(
    'resumes versioned five-step onboarding progress %i at the matching current page',
    (legacyStep, title) => {
      const html = renderOnboardingFlow({
        onboarding: {
          ...getDefaultOnboardingState(),
          flowVersion: 2,
          lastCompletedStep: legacyStep
        },
        onOnboardingChange: vi.fn()
      })

      expect(html).toContain(title)
      expect(html).not.toContain('Set up Orca for agents')
      expect(html).not.toContain('Explore Orca')
    }
  )

  it.each([
    [3, 'Set up notifications'],
    [4, 'Set up notifications'],
    [9, 'Set up notifications']
  ])(
    'resumes versioned four-step onboarding progress %i without showing Windows setup on Mac',
    (legacyStep, title) => {
      const html = renderOnboardingFlow({
        onboarding: {
          ...getDefaultOnboardingState(),
          flowVersion: 3,
          lastCompletedStep: legacyStep
        },
        onOnboardingChange: vi.fn()
      })

      expect(html).toContain(title)
      expect(html).not.toContain('Set Windows terminal defaults')
    }
  )

  it('shows the Windows terminal defaults page for Windows users after integrations', () => {
    vi.stubGlobal('navigator', { userAgent: 'Windows' })

    const html = renderOnboardingFlow({
      onboarding: {
        ...getDefaultOnboardingState(),
        lastCompletedStep: 3
      },
      onOnboardingChange: vi.fn()
    })

    expect(html).toContain('Set Windows terminal defaults')
    expect(html).toContain('5 of 6')
  })

  it('drops the skipped integrations step from the stepper on Windows', () => {
    vi.stubGlobal('navigator', { userAgent: 'Windows' })
    useAppStore.setState({
      preflightStatus: {
        git: { installed: true },
        gh: { installed: true, authenticated: false }
      },
      preflightStatusChecked: true
    })

    const html = renderOnboardingFlow({
      onboarding: {
        ...getDefaultOnboardingState(),
        lastCompletedStep: 2
      },
      onOnboardingChange: vi.fn()
    })

    expect(html).toContain('Set Windows terminal defaults')
    // Installed gh skips Integrations entirely; Windows terminal is page four of the five visible pages.
    expect(html).toContain('4 of 5')
    expect(html).not.toContain('Set up GitHub tasks')
    expect(html).not.toContain('Integrations')
  })

  it('skips GitHub task setup when the GitHub CLI is already detected', () => {
    useAppStore.setState({
      preflightStatus: {
        git: { installed: true },
        gh: { installed: true, authenticated: false }
      },
      preflightStatusChecked: true
    })

    const html = renderOnboardingFlow({
      onboarding: {
        ...getDefaultOnboardingState(),
        lastCompletedStep: 2
      },
      onOnboardingChange: vi.fn()
    })

    expect(html).toContain('Set up notifications')
    expect(html).toContain('Add your first project')
    expect(html).not.toContain('Set up GitHub tasks')
    expect(html).not.toContain('Connect your task sources')
    expect(html).not.toContain('Point Orca at some code')
    // Installed gh and macOS skip Integrations/Windows terminal, leaving four visible pages.
    expect(html).toContain('4 of 4')
    expect(html).not.toContain('Integrations')
  })

  it('shows only GitHub on the task setup page when the GitHub CLI is missing', () => {
    useAppStore.setState({
      preflightStatus: {
        git: { installed: true },
        gh: { installed: false, authenticated: false }
      },
      preflightStatusChecked: true
    })

    const html = renderOnboardingFlow({
      onboarding: {
        ...getDefaultOnboardingState(),
        lastCompletedStep: 2
      },
      onOnboardingChange: vi.fn()
    })

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

  it('exposes an accessible onboarding dialog', () => {
    const html = renderOnboardingFlow({
      onboarding: getDefaultOnboardingState(),
      onOnboardingChange: vi.fn()
    })

    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
  })
})
