// AGENT-PICKER-WIDTH: the composer's Agent menu is as wide as its field in every state. Neil's case:
// Project "~" (a folder, not a git repository) with Run on = Orca Cloud, which used to fall back to
// the compact 256 px menu under the full-width field.
import React from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { AgentLaunchPicker } from '@/components/agent/AgentLaunchPicker'
import type { AgentComboboxSurfaceRows } from '@/components/agent/agent-combobox-surface-items'
import { orcaCloudAgentMenuModel } from '@/lib/orca-cloud/orca-cloud-agent-picker'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { NewWorkspaceComposerAgentSection } from './NewWorkspaceComposerAgentSection'

const noop = (): void => {}
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 80))

const model = orcaCloudAgentMenuModel({ defaultTuiAgent: 'claude', disabledTuiAgents: [] })
const STATUS: ReadonlyMap<TuiAgent, string> = new Map<TuiAgent, string>([
  ['codex', 'Not set up'],
  ['gemini', 'Not set up'],
  ['cursor', 'Not set up']
])
const rows: AgentComboboxSurfaceRows = {
  model,
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the picker reads only selection.cli.
  selection: { cli: false } as AgentComboboxSurfaceRows['selection'],
  onPick: noop,
  statusLabels: STATUS
}

function Context({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="h-[520px] bg-background p-4">
      <div className="w-[460px] space-y-2">
        <p className="text-xs text-muted-foreground">Project: ~ (folder) · Run on: Orca Cloud</p>
        {children}
      </div>
    </div>
  )
}

const open = async (frame: HTMLElement): Promise<void> => {
  // Radix menus open on pointerdown, not click.
  frame
    .querySelector<HTMLButtonElement>('button[aria-haspopup]')
    ?.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })
    )
  await settle()
}

/** After: the composer's Agent section as the card renders it, menu open. */
export const homeFolderOrcaCloud = defineFixture({
  width: 500,
  render: () => (
    <Context>
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
    </Context>
  ),
  interact: open
})

/** Before (n39): the same menu at its compact width, for comparison. */
export const homeFolderOrcaCloudBefore = defineFixture({
  width: 500,
  render: () => (
    <Context>
      <AgentLaunchPicker
        model={model}
        agent="claude"
        matchTriggerWidth={false}
        emptyLabel="Blank terminal"
        defaultAgent="claude"
        onSetDefault={noop}
        onSelectBlankTerminal={noop}
        onPick={noop}
        statusLabels={STATUS}
      />
    </Context>
  ),
  interact: open
})
