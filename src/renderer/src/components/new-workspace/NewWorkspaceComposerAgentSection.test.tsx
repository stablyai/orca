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

    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(screen.getByRole('option', { name: 'Blank Terminal' }))

    expect(onQuickAgentChange).toHaveBeenCalledWith(null)
  })
})
