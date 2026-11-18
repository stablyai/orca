// @vitest-environment happy-dom

import { renderToStaticMarkup } from 'react-dom/server'
import { Bot, GitBranch, Mic, Network, Puzzle } from 'lucide-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import type * as ShortcutLabels from '@/lib/keyboard/useShortcutLabel'
import { SettingsSidebar } from './SettingsSidebar'
import { TooltipProvider } from '../../ui/tooltip'
import type { SettingsSetupGuideProgress } from '../setup-guide/settings-setup-guide-progress'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'

const mocks = vi.hoisted(() => ({
  useSettingsSetupGuideProgress: vi.fn()
}))

vi.mock('@/lib/keyboard/useShortcutLabel', async () => {
  const actual = await vi.importActual<typeof ShortcutLabels>('@/lib/keyboard/useShortcutLabel')
  return {
    ...actual,
    useShortcutLabel: () => '⌘F',
    useShortcutKeyComboDetails: () => [{ keys: ['⌘', 'F'], doubleTap: false }]
  }
})

vi.mock('../setup-guide/settings-setup-guide-progress', () => ({
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
        searchCandidates={[]}
        onBack={vi.fn()}
        onSelectSection={vi.fn()}
        onOpenSearchResult={vi.fn()}
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

  it("shows each bot's avatar in its row, above Projects", () => {
    const markup = renderToStaticMarkup(
      <TooltipProvider>
        <SettingsSidebar
          activeSectionId="bot-b1"
          settings={getDefaultSettings('/tmp')}
          generalGroups={[
            {
              id: 'bots',
              title: 'Bots',
              sections: [
                {
                  id: 'bot-b1',
                  title: 'Reviewer',
                  icon: Bot,
                  bot: { id: 'b1', hostId: 'local', name: 'Reviewer', avatar: '🦉' }
                }
              ]
            }
          ]}
          repoSections={[]}
          searchCandidates={[]}
          onBack={vi.fn()}
          onSelectSection={vi.fn()}
          onOpenSearchResult={vi.fn()}
        />
      </TooltipProvider>
    )

    expect(markup).toContain('🦉')
    // The generic icon renders as lucide-bot elsewhere in the nav.
    expect(renderSidebar()).toContain('lucide-bot')
    expect(markup).not.toContain('lucide-bot')
    expect(markup.indexOf('Reviewer')).toBeLessThan(markup.indexOf('Projects'))
  })
})
