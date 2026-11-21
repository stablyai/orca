// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { isFromWorkspaceAgentRow, WORKSPACE_AGENT_ROW_ATTR } from './workspace-agent-row-marker'

const SCOPE = 'data-worktree-context-menu-scope'

function card(): {
  scope: HTMLElement
  header: HTMLElement
  row: HTMLElement
  button: HTMLElement
} {
  const scope = document.createElement('div')
  scope.setAttribute(SCOPE, 'worktree')
  const header = document.createElement('div')
  const row = document.createElement('div')
  row.setAttribute(WORKSPACE_AGENT_ROW_ATTR, 'true')
  const label = document.createElement('span')
  const button = document.createElement('button')
  row.append(label, button)
  scope.append(header, row)
  document.body.append(scope)
  return { scope, header, row, button }
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('isFromWorkspaceAgentRow', () => {
  it('counts the row and anything inside it, including a focused control', () => {
    const { scope, row, button } = card()
    expect(isFromWorkspaceAgentRow(scope, row)).toBe(true)
    expect(isFromWorkspaceAgentRow(scope, row.firstChild)).toBe(true)
    expect(isFromWorkspaceAgentRow(scope, button)).toBe(true)
  })

  it('leaves the rest of the card alone', () => {
    const { scope, header } = card()
    expect(isFromWorkspaceAgentRow(scope, header)).toBe(false)
    expect(isFromWorkspaceAgentRow(scope, scope)).toBe(false)
    expect(isFromWorkspaceAgentRow(scope, null)).toBe(false)
  })

  it('accepts a text node target through its parent', () => {
    const { scope, row } = card()
    const text = document.createTextNode('agent')
    row.append(text)
    expect(isFromWorkspaceAgentRow(scope, text)).toBe(true)
  })

  it('gives a nested card’s agent row to that card, not its parent', () => {
    const parent = card()
    const nested = card()
    parent.scope.append(nested.scope)
    expect(isFromWorkspaceAgentRow(parent.scope, nested.row)).toBe(false)
    expect(isFromWorkspaceAgentRow(nested.scope, nested.row)).toBe(true)
  })
})
