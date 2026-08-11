// @vitest-environment happy-dom

import { renderToStaticMarkup } from 'react-dom/server'
import { Bot, GitBranch, Mic, Network, Puzzle } from 'lucide-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { SettingsSidebar } from './SettingsSidebar'
import { TooltipProvider } from '../ui/tooltip'
import type { SettingsSetupGuideProgress } from './settings-setup-guide-progress'
import type { GlobalSettings } from '../../../../shared/types'

const mocks = vi.hoisted(() => ({
  useSettingsSetupGuideProgress: vi.fn()
}))

vi.mock('@/hooks/useShortcutLabel', () => ({
  useShortcutLabel: () => '⌘F',
  useShortcutKeyComboDetails: () => [{ keys: ['⌘', 'F'], doubleTap: false }]
}))

vi.mock('./settings-setup-guide-progress', () => ({
  useSettingsSetupGuideProgress: mocks.useSettingsSetupGuideProgress
}))

function makeSetupGuideProgress(
  overrides: Partial<SettingsSetupGuideProgress> = {}
): SettingsSetupGuideProgress {
  return {
    ready: true,
    doneCount: 5,
    total: 8,
    firstIncompleteStepId: 'agent-capabilities',
    ...overrides
  }
}

function renderSidebar(
  activeSectionId = 'orchestration',
  settings: GlobalSettings = getDefaultSettings('/tmp')
): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <SettingsSidebar
        activeSectionId={activeSectionId}
        settings={settings}
        generalGroups={[
          {
            id: 'capabilities',
            title: 'AI Capabilities',
            sections: [
              {
                id: 'agents',
                title: 'Agents',
                icon: Bot
              },
              {
                id: 'orchestration',
                title: 'Orchestration',
                icon: Network,
                installStatus: 'install'
              },
              {
                id: 'voice',
                title: 'Voice',
                icon: Mic,
                installStatus: 'installed'
              },
              {
                id: 'computer-use',
                title: 'Computer Use',
                icon: Bot,
                installStatus: 'up-to-date'
              },
              {
                id: 'voice-loading',
                title: 'Voice Loading',
                icon: Mic,
                installStatus: 'checking'
              },
              {
                id: 'linear',
                title: 'Linear',
                icon: GitBranch,
                installStatus: 'update-available'
              },
              {
                id: 'ephemeral-vms',
                title: 'Ephemeral VMs',
                icon: Bot,
                installStatus: 'needs-attention'
              },
              {
                id: 'plugins',
                title: 'Plugins',
                icon: Puzzle
              }
            ]
          },
          {
            id: 'setup',
            title: 'Set Up',
            sections: [
              {
                id: 'accounts',
                title: 'AI Provider Accounts',
                icon: Bot,
                badge: 'Optional'
              }
            ]
          }
        ]}
        repoSections={[]}
        hasRepos={false}
        searchQuery=""
        onBack={vi.fn()}
        onSearchChange={vi.fn()}
        onSelectSection={vi.fn()}
      />
    </TooltipProvider>
  )
}

describe('SettingsSidebar', () => {
  beforeEach(() => {
    mocks.useSettingsSetupGuideProgress.mockReset()
    mocks.useSettingsSetupGuideProgress.mockReturnValue(makeSetupGuideProgress())
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('applies left sidebar appearance styles to the settings navigation', () => {
    const markup = renderSidebar('orchestration', {
      ...getDefaultSettings('/tmp'),
      leftSidebarAppearanceMode: 'match-terminal',
      terminalColorOverrides: {
        background: '#101820',
        foreground: '#f0f4f8'
      }
    })

    expect(markup).toContain('--worktree-sidebar:#101820')
    expect(markup).toContain('--worktree-sidebar-foreground:#f0f4f8')
  })

  it('reserves install state labels for actionable skill states', () => {
    const markup = renderSidebar()

    expect(markup).not.toContain('Not installed')
    expect(markup).not.toContain('Installed')
    expect(markup).not.toContain('Up to date')
    expect(markup).not.toContain('Checking...')
    expect(markup).toContain('Update available')
    expect(markup).toContain('Review skill')
    expect(markup).toContain('Optional')
  })

  it('does not render the setup guide row before progress readiness settles', () => {
    mocks.useSettingsSetupGuideProgress.mockReturnValue(
      makeSetupGuideProgress({
        ready: false,
        doneCount: 7,
        firstIncompleteStepId: 'setup-script'
      })
    )

    expect(renderSidebar()).not.toContain('Onboarding checklist')
  })

  it('renders incomplete setup progress with the full checklist total', () => {
    const markup = renderSidebar()

    expect(markup).toContain('Onboarding checklist')
    expect(markup).toContain('Onboarding checklist, 5 of 8 done. Show setup guide.')
    expect(markup).toContain('5 of 8 setup steps complete')
  })

  it('does not render the setup guide row after every checklist step is complete', () => {
    mocks.useSettingsSetupGuideProgress.mockReturnValue(
      makeSetupGuideProgress({
        doneCount: 8,
        firstIncompleteStepId: null
      })
    )

    expect(renderSidebar()).not.toContain('Onboarding checklist')
  })

  it('keeps the setup guide row available from Settings when incomplete', () => {
    const markup = renderSidebar('setup-guide')

    expect(markup).toContain('aria-current="page"')
    expect(markup).toContain('Onboarding checklist')
  })
})
