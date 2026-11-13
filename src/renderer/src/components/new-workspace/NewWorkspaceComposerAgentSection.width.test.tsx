// @vitest-environment happy-dom
// AGENT-PICKER-WIDTH: the composer's Agent menu takes its field's width in every state, including a
// folder project ("~") with Orca Cloud, which used to get the compact 256 px menu.
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AgentComboboxSurfaceRows } from '@/components/agent/agent-combobox-surface-items'
import { orcaCloudAgentMenuModel } from '@/lib/orca-cloud/orca-cloud-agent-picker'
import { NewWorkspaceComposerAgentSection } from './NewWorkspaceComposerAgentSection'

const noop = (): void => {}

afterEach(() => cleanup())

describe('composer Agent menu width', () => {
  it('matches the field, with no project-kind condition', () => {
    const rows: AgentComboboxSurfaceRows = {
      model: orcaCloudAgentMenuModel({ defaultTuiAgent: 'claude', disabledTuiAgents: [] }),
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the picker reads only selection.cli.
      selection: { cli: false } as AgentComboboxSurfaceRows['selection'],
      onPick: noop
    }
    const view = render(
      <TooltipProvider>
        <NewWorkspaceComposerAgentSection
          quickAgent="claude"
          agentSurfaceRows={rows}
          agentSetupDisabled={false}
          onQuickAgentChange={noop}
          onOpenAgentSettings={noop}
          createDisabled={false}
          onCreate={noop}
          advancedOpen={false}
          onToggleAdvanced={noop}
          visibleQuickAgents={[]}
          defaultTuiAgent="claude"
          handleSetDefaultAgent={noop}
        />
      </TooltipProvider>
    )
    const trigger = view.container.querySelector<HTMLButtonElement>('button[aria-haspopup]')
    expect(trigger).not.toBeNull()
    act(() => {
      fireEvent.pointerDown(trigger!, { button: 0, pointerType: 'mouse' })
    })
    const menu = document.querySelector('[data-slot="dropdown-menu-content"]')
    expect(menu).not.toBeNull()
    expect(menu!.className).toContain('w-(--radix-dropdown-menu-trigger-width)')
    expect(menu!.className).not.toContain('min-w-64')
  })
})
