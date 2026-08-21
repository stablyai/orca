import { describe, expect, it } from 'vitest'
import { agentRowOwnsTabName, agentRowPrimaryLabel } from './agent-row-display-name'
import { makePaneKey } from '../../../shared/stable-pane-id'

const TAB_ID = 'tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const row = (
  overrides: Partial<Parameters<typeof agentRowOwnsTabName>[0]> & {
    parentPaneKey?: string
    prompt?: string
  } = {}
): Parameters<typeof agentRowOwnsTabName>[0] => ({
  entry: {
    prompt: overrides.prompt ?? '',
    orchestration: overrides.parentPaneKey ? { parentPaneKey: overrides.parentPaneKey } : undefined
  } as Parameters<typeof agentRowOwnsTabName>[0]['entry'],
  tab: { id: TAB_ID },
  lineage: overrides.lineage,
  rowSource: overrides.rowSource
})

describe('agentRowOwnsTabName', () => {
  it('lets a root row own its tab name', () => {
    expect(agentRowOwnsTabName(row())).toBe(true)
  })

  it('refuses a synthetic subagent row', () => {
    expect(agentRowOwnsTabName(row({ rowSource: 'subagent' }))).toBe(false)
  })

  it('refuses a child rendered on its parent tab', () => {
    const child = row({
      lineage: { depth: 1 },
      parentPaneKey: makePaneKey(TAB_ID, LEAF_ID)
    })
    expect(agentRowOwnsTabName(child)).toBe(false)
  })

  it('lets a child on its own tab keep the name', () => {
    const child = row({
      lineage: { depth: 1 },
      parentPaneKey: makePaneKey('tab-other', LEAF_ID)
    })
    expect(agentRowOwnsTabName(child)).toBe(true)
  })

  it('lets a depth-0 row with a parent key keep the name', () => {
    const sibling = row({
      lineage: { depth: 0 },
      parentPaneKey: makePaneKey(TAB_ID, LEAF_ID)
    })
    expect(agentRowOwnsTabName(sibling)).toBe(true)
  })
})

describe('agentRowPrimaryLabel', () => {
  it('prefers the conversation name', () => {
    expect(agentRowPrimaryLabel(row({ prompt: 'fix the bug' }), 'Designer')).toBe('Designer')
  })

  it('falls through to what the agent is working on', () => {
    expect(agentRowPrimaryLabel(row({ prompt: 'fix the bug' }), null)).toBe('fix the bug')
  })

  it('returns empty when neither exists, leaving the last resort to the caller', () => {
    expect(agentRowPrimaryLabel(row(), null)).toBe('')
  })
})
