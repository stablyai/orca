// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentCatalogRow, type AgentCatalogRowProps } from './AgentCatalogRow'
import { TooltipProvider } from '../../../ui/tooltip'
import {
  agentPermissionChoiceLabel,
  type AgentPermissionChoiceRow
} from '../../../agent/launch-settings/AgentPermissionChoiceControls'

afterEach(cleanup)

const ownPermission: AgentPermissionChoiceRow = {
  choices: ['own', 'ask', 'accept-edits', 'auto', 'full-access'],
  choice: 'own',
  source: 'agent',
  defaultChoice: 'full-access',
  onSelect: () => {},
  flag: '',
  argsSetPermission: false
}

const props: AgentCatalogRowProps = {
  agentId: 'claude',
  label: 'Claude',
  homepageUrl: 'https://claude.com/claude-code',
  defaultCmd: 'claude',
  defaultArgs: '',
  defaultEnv: {},
  isDetected: true,
  isEnabled: true,
  isDefault: true,
  cmdOverride: undefined,
  argsOverride: '',
  envOverride: {},
  onSetDefault: () => {},
  onSetEnabled: () => {},
  onSaveOverride: () => {},
  onSaveArgs: () => {},
  onSaveEnv: () => {},
  permissionChoice: ownPermission
}

function renderRow(overrides: Partial<AgentCatalogRowProps> = {}): void {
  render(
    <TooltipProvider>
      <AgentCatalogRow {...props} {...overrides} />
    </TooltipProvider>
  )
}

describe('AgentCatalogRow permission badge', () => {
  const label = agentPermissionChoiceLabel(ownPermission.choice, props.label)

  it('states the agent own permission once when collapsed', () => {
    renderRow()
    expect(screen.getAllByText(label)).toHaveLength(1)
  })

  it('does not repeat the choice once the Permissions control is visible', () => {
    renderRow()
    fireEvent.click(screen.getByLabelText('Expand agent settings'))
    // The control below states the same choice, so a badge here would be the words twice.
    expect(screen.getAllByText(label)).toHaveLength(1)
  })

  it('keeps the badge for agents following the all-agents choice out of both states', () => {
    renderRow({ permissionChoice: { ...ownPermission, source: 'all' } })
    expect(screen.queryAllByText(label)).toHaveLength(0)
    fireEvent.click(screen.getByLabelText('Expand agent settings'))
    expect(screen.getAllByText(label)).toHaveLength(1)
  })
})
