import { expect, it } from 'vitest'
import { agentPickerEntriesFromRows } from './agent-launch-picker'
import type { NewTabAgentMenuRow } from './agent-launch-picker-rows'
import type { TuiAgent } from '../catalog/tui-agent'

// The catalog order interleaves agents this host has with ones it lacks.
const hostRows: NewTabAgentMenuRow[] = [
  { kind: 'chat', agent: 'codex' },
  { kind: 'chat', agent: 'opencode', setup: true },
  { kind: 'chat-unavailable', agent: 'grok', reason: 'not-installed' },
  { kind: 'cli', agent: 'claude' },
  { kind: 'terminal', agent: 'antigravity' },
  { kind: 'chat-unavailable', agent: 'cursor', reason: 'not-on-host' },
  { kind: 'cli', agent: 'cursor' }
]

const order = (defaultAgent: TuiAgent | null): TuiAgent[] =>
  agentPickerEntriesFromRows(
    hostRows,
    ['claude', 'antigravity', 'cursor'],
    () => ({ terminal: {}, structured: {} }),
    (agent) => agent,
    defaultAgent
  ).map((entry) => entry.agent)

it('lists the agents ready on the host before the ones it lacks, each group in catalog order', () => {
  expect(order('antigravity')).toEqual([
    'antigravity',
    'claude',
    'codex',
    'cursor',
    'grok',
    'opencode'
  ])
})

it('does not let a default the host lacks lead the agents it has', () => {
  expect(order('grok')).toEqual(['claude', 'codex', 'antigravity', 'cursor', 'grok', 'opencode'])
})
