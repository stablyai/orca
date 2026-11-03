// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AGENT_CATALOG } from '@/lib/agent-catalog'
import { NewWorkspaceComposerAgentSection } from './NewWorkspaceComposerAgentSection'

afterEach(cleanup)

describe('NewWorkspaceComposerAgentSection agent picker', () => {
  it('offers Blank Terminal because a workspace can start without an agent', () => {
    const onQuickAgentChange = vi.fn()
    render(
      <TooltipProvider>
        <NewWorkspaceComposerAgentSection
          quickAgent="codex"
          agentSurfaceRows={{
            model: {
              state: 'settled',
              rows: [{ agent: 'codex', kind: 'terminal' }],
              detection: {
                detectedIds: ['codex'],
                isLoading: false,
                isRefreshing: false,
                detectionFailed: false,
                needsServerUpdate: false,
                refresh: async () => ['codex']
              }
            },
            selection: { ready: true, cli: false },
            contextKey: 'test',
            onPick: vi.fn()
          }}
          onQuickAgentChange={onQuickAgentChange}
          onOpenAgentSettings={vi.fn()}
          createDisabled={false}
          onCreate={vi.fn()}
          advancedOpen={false}
          onToggleAdvanced={vi.fn()}
          visibleQuickAgents={AGENT_CATALOG}
          defaultTuiAgent="blank"
          handleSetDefaultAgent={vi.fn()}
        />
      </TooltipProvider>
    )

    expect(screen.getByRole('button', { name: 'Select agent' }).textContent).not.toContain('Chat')
    expect(screen.getByRole('button', { name: 'Select agent' }).textContent).not.toContain('(CLI)')
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Select agent' }), {
      button: 0,
      ctrlKey: false
    })
    const blankTerminal = screen.getByRole('menuitem', { name: 'Blank Terminal' })
    expect(blankTerminal.querySelector('svg')).not.toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Setup only' })).toBeNull()
    expect(screen.getByRole('menuitem', { name: 'Agent settings…' })).toBeTruthy()
    fireEvent.click(blankTerminal)

    expect(onQuickAgentChange).toHaveBeenCalledWith(null)
  })
})
