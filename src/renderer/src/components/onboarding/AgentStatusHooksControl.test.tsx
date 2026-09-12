// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAgentHookConfigLocations } from '../../../../shared/agent-hook-config-locations'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AgentStep } from './AgentStep'
import { AgentStatusHooksControl } from './AgentStatusHooksControl'

// `opencode` is a launchable agent with no managed hook, `cursor` is a hook target the user turned
// off, `claude` is the one row that must survive. A fixture missing any of the three passes under
// a wrong implementation.
const DETECTED: TuiAgent[] = ['claude', 'cursor', 'opencode']
const DISABLED = ['cursor']

function renderControl(
  overrides: Partial<React.ComponentProps<typeof AgentStatusHooksControl>> = {}
) {
  const onEnabledChange = vi.fn()
  render(
    <AgentStatusHooksControl
      enabled
      onEnabledChange={onEnabledChange}
      detectedAgentIds={DETECTED}
      disabledTuiAgents={DISABLED}
      {...overrides}
    />
  )
  return { onEnabledChange }
}

function disclosureTrigger(): HTMLElement {
  return screen.getByText('What Orca changes, and when')
}

afterEach(cleanup)

describe('AgentStatusHooksControl', () => {
  it('renders checked by default and reports a single uncheck', async () => {
    const { onEnabledChange } = renderControl()
    const checkbox = screen.getByRole('checkbox', { name: 'Enable agent status hooks' })
    expect(checkbox).toBeChecked()

    await userEvent.click(checkbox)

    expect(onEnabledChange).toHaveBeenCalledTimes(1)
    expect(onEnabledChange).toHaveBeenCalledWith(false)
  })

  it('starts with the disclosure collapsed', () => {
    renderControl()

    expect(disclosureTrigger()).toHaveAttribute('data-state', 'closed')
    expect(screen.queryByText(/Still checking which agent CLIs/)).not.toBeInTheDocument()
    expect(screen.queryByText('Claude')).not.toBeInTheDocument()
  })

  it('lists exactly the detected hook targets the user has not disabled', async () => {
    renderControl()

    await userEvent.click(disclosureTrigger())

    const list = screen.getByRole('list')
    const rows = within(list).getAllByRole('listitem')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveTextContent('Claude')
    expect(rows[0]).toHaveTextContent(getAgentHookConfigLocations('darwin').claude)
    expect(within(list).queryByText('Cursor')).not.toBeInTheDocument()
    expect(within(list).queryByText('OpenCode')).not.toBeInTheDocument()
  })

  it('tells the truth about both Codex lanes', async () => {
    renderControl({ detectedAgentIds: ['codex'], disabledTuiAgents: [] })

    await userEvent.click(disclosureTrigger())

    const row = within(screen.getByRole('list')).getByRole('listitem')
    expect(row).toHaveTextContent('~/.codex/hooks.json + config.toml')
    expect(row).toHaveTextContent('Orca-managed Codex home')
  })

  it('renders a detecting state that is distinct from the empty state', async () => {
    renderControl({ detectedAgentIds: [], isDetecting: true })

    await userEvent.click(disclosureTrigger())

    expect(screen.getByText(/Still checking which agent CLIs/)).toBeInTheDocument()
    expect(screen.queryByText(/No agent CLIs found on your PATH/)).not.toBeInTheDocument()
  })

  it('renders an empty state once detection has finished', async () => {
    renderControl({ detectedAgentIds: [], isDetecting: false })

    await userEvent.click(disclosureTrigger())

    expect(screen.getByText(/No agent CLIs found on your PATH/)).toBeInTheDocument()
    expect(screen.queryByText(/Still checking which agent CLIs/)).not.toBeInTheDocument()
  })

  it('says the affected list is only approximate', async () => {
    renderControl()

    await userEvent.click(disclosureTrigger())

    expect(screen.getByText(/This list is approximate/)).toBeInTheDocument()
  })

  it('does not promise the write happens on continue, which is false for a returning user', async () => {
    renderControl()

    await userEvent.click(disclosureTrigger())

    expect(screen.queryByText(/When you continue from this step/)).not.toBeInTheDocument()
    expect(screen.getByText(/kept current each time Orca starts/)).toBeInTheDocument()
  })

  it('states the consequence of unchecking in muted text, not as an error', () => {
    renderControl({ enabled: false })

    const consequence = screen.getByText(/Resumed sessions show no status until you type/)
    expect(consequence).toHaveClass('text-muted-foreground')
    expect(consequence.className).not.toMatch(/amber/)
  })

  it('keeps the whole control inside one card', () => {
    const { container } = render(
      <AgentStatusHooksControl enabled detectedAgentIds={DETECTED} disabledTuiAgents={DISABLED} />
    )

    const card = container.firstElementChild
    expect(card?.className).toContain('border-border')
    // The label must not carry its own border, or the checkbox row reads as a separate card.
    expect(card?.querySelector('label')?.className).not.toContain('border')
  })
})

describe('AgentStep wiring', () => {
  it('passes its detection state down to the hooks disclosure', async () => {
    render(
      <TooltipProvider>
        <AgentStep
          selectedAgent={null}
          onSelect={vi.fn()}
          detectedSet={new Set<TuiAgent>()}
          isDetecting
        />
      </TooltipProvider>
    )

    await userEvent.click(disclosureTrigger())

    expect(screen.getByText(/Still checking which agent CLIs/)).toBeInTheDocument()
  })
})
