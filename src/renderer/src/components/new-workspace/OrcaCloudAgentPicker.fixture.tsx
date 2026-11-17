// The composer's agent picker with Orca Cloud as the run target: the image's six agents, as
// installed, each with the same per-agent setup (model, effort, permissions, arguments) as local.
import React from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { AgentLaunchPicker } from '@/components/agent/AgentLaunchPicker'
import { orcaCloudAgentMenuModel } from '@/lib/orca-cloud/orca-cloud-agent-picker'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'

const noop = (): void => {}
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 80))

function Picker(props: {
  agent: TuiAgent
  disabled?: TuiAgent[]
  statusLabels?: ReadonlyMap<TuiAgent, string>
}): React.JSX.Element {
  const model = orcaCloudAgentMenuModel({
    defaultTuiAgent: 'claude',
    disabledTuiAgents: props.disabled ?? []
  })
  return (
    <div className="h-[460px] bg-background p-4">
      <div className="w-[420px] space-y-1">
        <label className="text-xs font-medium text-muted-foreground">Agent</label>
        <AgentLaunchPicker
          model={model}
          agent={props.agent}
          emptyLabel="Blank Terminal"
          defaultAgent="claude"
          onSetDefault={noop}
          onSelectBlankTerminal={noop}
          onPick={noop}
          statusLabels={props.statusLabels}
        />
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

/** Claude's setup submenu: the built-in catalog, since the VM doesn't exist yet. */
const openClaudeSetup = async (frame: HTMLElement): Promise<void> => {
  await open(frame)
  document
    .querySelector<HTMLButtonElement>('[data-agent-launch-row] button[aria-haspopup="menu"]')
    ?.click()
  await settle()
}

export const closed = defineFixture({ width: 480, render: () => <Picker agent="claude" /> })

export const openSix = defineFixture({
  width: 480,
  render: () => <Picker agent="claude" />,
  interact: open
})

export const openTwoDisabled = defineFixture({
  width: 480,
  render: () => <Picker agent="claude" disabled={['cursor', 'copilot']} />,
  interact: open
})

/** Each row says whether a cloud workspace can run it as-is (inside the open menu only). */
// No status means ready: Claude, OpenCode and Copilot carry none here.
const STATUS: ReadonlyMap<TuiAgent, string> = new Map<TuiAgent, string>([
  ['codex', 'Not set up'],
  ['gemini', 'Not set up'],
  ['cursor', 'Not set up']
])

export const openWithStatus = defineFixture({
  width: 480,
  render: () => <Picker agent="claude" statusLabels={STATUS} />,
  interact: open
})

/** Closed: nothing changes on the button. */
export const closedWithStatus = defineFixture({
  width: 480,
  render: () => <Picker agent="claude" statusLabels={STATUS} />
})

/** Orca-account sign-in off here (prod today): Claude and Codex sign in per workspace. */
export const openPerWorkspace = defineFixture({
  width: 480,
  render: () => (
    <Picker
      agent="claude"
      statusLabels={
        new Map<TuiAgent, string>([
          ['claude', 'Signs in per workspace'],
          ['codex', 'Signs in per workspace'],
          ['opencode', 'Not set up'],
          ['gemini', 'Not set up'],
          ['cursor', 'Not set up'],
          ['copilot', 'Not set up']
        ])
      }
    />
  ),
  interact: open
})

export const openSetup = defineFixture({
  width: 720,
  render: () => <Picker agent="claude" statusLabels={STATUS} />,
  interact: openClaudeSetup
})

/** The shown agent isn't set up: its tab is marked and the strip says so. */
export const openNotSetUp = defineFixture({
  width: 480,
  render: () => <Picker agent="codex" statusLabels={STATUS} />,
  interact: open
})
