// The composer's agent picker with Orca Cloud as the run target: the image's six agents, as installed.
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
  notice?: string
  statusLabels?: ReadonlyMap<TuiAgent, string>
}): React.JSX.Element {
  const model = orcaCloudAgentMenuModel({
    defaultTuiAgent: 'claude',
    disabledTuiAgents: props.disabled ?? []
  })
  return (
    <div className="h-[460px] bg-background p-4">
      <div className="w-[420px] space-y-1">
        <label className="text-xs font-medium text-muted-foreground">Agent (optional)</label>
        <AgentLaunchPicker
          model={model}
          agent={props.agent}
          matchTriggerWidth
          emptyLabel="Blank terminal"
          defaultAgent="claude"
          onSetDefault={noop}
          onSelectBlankTerminal={noop}
          onPick={noop}
          statusLabels={props.statusLabels}
        />
        {props.notice ? <p className="text-xs text-muted-foreground">{props.notice}</p> : null}
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

/** The user's default (Aider) isn't on the image: said once under the picker, not swapped silently. */
export const fallback = defineFixture({
  width: 480,
  render: () => (
    <Picker
      agent="claude"
      notice="Aider isn’t available on Orca Cloud yet, so Claude is selected."
    />
  )
})

/** JA-22: each row says whether a cloud workspace can run it as-is (inside the open menu only). */
// No status means ready (design-squad): Claude, OpenCode and Copilot carry none here.
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

/** Closed: nothing changes on the button (Neil). */
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
