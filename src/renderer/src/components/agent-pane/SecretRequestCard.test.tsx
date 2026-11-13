// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SecretRequestCard,
  type SecretRequestCardActions,
  type SecretRequestCardModel
} from './SecretRequestCard'

const noop = (): void => {}
const ACTIONS: SecretRequestCardActions = {
  onValueChange: noop,
  onScopeChange: noop,
  onAdd: noop,
  onNotNow: noop,
  onRetry: noop,
  onRestart: noop,
  onDismiss: noop,
  onToggleCollapsed: noop,
  onCollapse: noop
}
const BASE: SecretRequestCardModel = {
  agent: null,
  name: 'NPM_TOKEN',
  reason: 'Publish the package',
  suggestedRepo: false,
  scopes: ['personal'],
  scope: 'personal',
  value: '',
  phase: 'open',
  fieldError: null,
  more: 0,
  canRestart: false,
  collapsed: false,
  sharedWorkspace: false
}

afterEach(cleanup)

describe('SecretRequestCard copy', () => {
  it('an unknown asker reads as a command, with no repeated "from" line', () => {
    render(<SecretRequestCard model={BASE} actions={ACTIONS} />)
    expect(screen.getByRole('heading').textContent).toBe('A command asked for NPM_TOKEN')
    expect(screen.queryByText(/^from /)).toBeNull()
  })

  it('a known agent keeps its "from" line', () => {
    render(<SecretRequestCard model={{ ...BASE, agent: 'Claude' }} actions={ACTIONS} />)
    expect(screen.getByText('from Claude')).toBeTruthy()
  })

  it('saved never claims the agent cannot read the value (it is a plain env var)', () => {
    render(
      <SecretRequestCard model={{ ...BASE, agent: 'Claude', phase: 'saved' }} actions={ACTIONS} />
    )
    const text = document.body.textContent ?? ''
    expect(text).toContain('New shells get it now. Claude was told it’s ready.')
    expect(text).not.toMatch(/never gets/)
  })
})
