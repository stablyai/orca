// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { sourceEntry } from './agent-launch-picker-sources.test-fixture'
import { AgentLaunchSetupPanel } from './AgentLaunchSetupPanel'
import { agentPickerDraft } from '../../../../shared/agent-launch/picker/agent-launch-picker'
import { TooltipProvider } from '@/components/ui/tooltip'
vi.mock('@/hooks/useShortcutLabel', () => ({ useOptionalShortcutLabel: () => null }))
afterEach(cleanup)
it.each(['chat', 'terminal'] as const)(
  'renders the %s draft inventory regardless of the default surface',
  (surface) => {
    const entry = sourceEntry(surface === 'chat' ? 'terminal' : 'chat')
    const draft = agentPickerDraft(entry, surface)
    render(
      <TooltipProvider>
        <AgentLaunchSetupPanel
          entry={entry}
          draft={draft}
          getDraft={() => draft}
          mode="select"
          onDraftChange={() => {}}
          onUse={() => true}
        />
      </TooltipProvider>
    )
    if (surface === 'terminal') {
      expect(screen.getByText('Gemini 3.8 Flash (Low)')).toBeTruthy()
      expect(screen.queryByText('Gemini 3.8 Flash')).toBeNull()
    } else {
      expect(screen.getByText('Gemini 3.8 Flash')).toBeTruthy()
      expect(screen.queryByText('Gemini 3.8 Flash (Low)')).toBeNull()
    }
  }
)
