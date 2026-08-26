import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { createTerminalTabGeneratedPaneTitleSelector } from './terminal-tab-generated-pane-titles'

function entry(paneKey: string, prompt: string): AgentStatusEntry {
  const tabId = paneKey.slice(0, paneKey.indexOf(':'))
  return {
    state: 'working',
    prompt,
    updatedAt: 1,
    stateStartedAt: 1,
    agentType: 'claude',
    paneKey,
    tabId,
    worktreeId: 'wt-1',
    stateHistory: []
  } as unknown as AgentStatusEntry
}

describe('generated pane titles', () => {
  it('names each pane of a tab after its own agent prompt', () => {
    const select = createTerminalTabGeneratedPaneTitleSelector()

    expect(
      select(
        {
          'tab-1:leaf-1': entry('tab-1:leaf-1', 'Please fix the flaky upload test. It times out.'),
          'tab-1:leaf-2': entry('tab-1:leaf-2', 'can you write the release notes for the launch'),
          'tab-2:leaf-1': entry('tab-2:leaf-1', 'Audit the billing webhook')
        },
        'tab-1'
      )
    ).toEqual({
      'leaf-1': 'Fix the flaky upload test',
      'leaf-2': 'Write the release notes for the launch'
    })
  })

  it('keeps the record identity stable so an unrelated status write does not re-render a pane', () => {
    const select = createTerminalTabGeneratedPaneTitleSelector()
    const first = { 'tab-1:leaf-1': entry('tab-1:leaf-1', 'Fix the flaky upload test') }
    const before = select(first, 'tab-1')
    // A new map with the same prompt: production replaces this object on every write.
    const after = select({ ...first }, 'tab-1')

    expect(after).toBe(before)
  })

  it('follows the prompt when the pane starts a new piece of work', () => {
    const select = createTerminalTabGeneratedPaneTitleSelector()
    select({ 'tab-1:leaf-1': entry('tab-1:leaf-1', 'Fix the flaky upload test') }, 'tab-1')

    expect(
      select({ 'tab-1:leaf-1': entry('tab-1:leaf-1', 'Audit the billing webhook') }, 'tab-1')
    ).toEqual({ 'leaf-1': 'Audit the billing webhook' })
  })

  it('omits a pane with no prompt and a tab with no agents', () => {
    const select = createTerminalTabGeneratedPaneTitleSelector()
    const state = {
      'tab-1:leaf-1': entry('tab-1:leaf-1', ''),
      'tab-1:leaf-2': entry('tab-1:leaf-2', '...')
    }

    expect(select(state, 'tab-1')).toEqual({})
    expect(select(state, 'tab-9')).toEqual({})
  })
})
