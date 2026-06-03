import { renderToStaticMarkup } from 'react-dom/server'
import { Bot, Mic, Network } from 'lucide-react'
import { describe, expect, it, vi } from 'vitest'
import { SettingsSidebar } from './SettingsSidebar'
import { TooltipProvider } from '../ui/tooltip'

vi.mock('@/hooks/useShortcutLabel', () => ({
  useShortcutLabel: () => '⌘F'
}))

function renderSidebar(): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <SettingsSidebar
        activeSectionId="orchestration"
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
  it('renders install state labels separately from static badges', () => {
    const markup = renderSidebar()

    expect(markup).toContain('Not installed')
    expect(markup).toContain('Installed')
    expect(markup).toContain('Optional')
  })
})
