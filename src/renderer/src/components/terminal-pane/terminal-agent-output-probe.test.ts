import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { PaneForegroundAgentEntry } from '../../store/slices/pane-foreground-agent'
import { paneRunsTuiAgent } from './terminal-agent-output-probe'

const statusRow = (extra: Partial<AgentStatusEntry> = {}): AgentStatusEntry => ({
  state: 'working',
  prompt: '',
  updatedAt: 1,
  stateStartedAt: 1,
  stateHistory: [],
  paneKey: 'tab-1:leaf-1',
  agentType: 'claude',
  ...extra
})

const foreground = (extra: Partial<PaneForegroundAgentEntry>): PaneForegroundAgentEntry => ({
  agent: null,
  shellForeground: false,
  ...extra
})

describe('paneRunsTuiAgent', () => {
  it('trusts a live foreground agent', () => {
    expect(paneRunsTuiAgent(foreground({ agent: 'claude' }), undefined)).toBe(true)
  })

  it('keeps an explicit foreground agent even when the shell flag is latched', () => {
    expect(
      paneRunsTuiAgent(foreground({ agent: 'claude', shellForeground: true }), statusRow())
    ).toBe(true)
  })

  it('falls back to a fresh status row when the foreground is unknown', () => {
    expect(paneRunsTuiAgent(undefined, statusRow())).toBe(true)
    expect(paneRunsTuiAgent(foreground({}), statusRow())).toBe(true)
  })

  it('ignores a stale status row once the foreground is proven to be the shell', () => {
    expect(paneRunsTuiAgent(foreground({ shellForeground: true }), statusRow())).toBe(false)
  })

  it('ignores a status row restored from disk', () => {
    expect(paneRunsTuiAgent(undefined, statusRow({ restoredUnconfirmed: true }))).toBe(false)
  })
})
