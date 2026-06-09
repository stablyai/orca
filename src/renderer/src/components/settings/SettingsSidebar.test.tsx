import { renderToStaticMarkup } from 'react-dom/server'
import { Bot, Mic, Network } from 'lucide-react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsSidebar } from './SettingsSidebar'
import { TooltipProvider } from '../ui/tooltip'
import type { SettingsSetupGuideProgress } from './settings-setup-guide-progress'

const mocks = vi.hoisted(() => ({
  useSettingsSetupGuideProgress: vi.fn()
}))

vi.mock('@/hooks/useShortcutLabel', () => ({
  useShortcutLabel: () => '⌘F'
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

function renderSidebar(activeSectionId = 'orchestration'): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <SettingsSidebar
        activeSectionId={activeSectionId}
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

  it('renders install state labels separately from static badges', () => {
    const markup = renderSidebar()

    expect(markup).toContain('Not installed')
    expect(markup).toContain('Installed')
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
