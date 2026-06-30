import { describe, expect, it } from 'vitest'
import {
  hasCompletedTabAgent,
  resolveCompletedTabAgent,
  resolveFocusedCompletedTabAgent,
  resolveFocusedTabAgent,
  resolveSiblingCompletedTabAgent,
  resolveSiblingTabAgent,
  resolveTabAgent
} from './tab-agent'
import type { AgentStatusEntry, AgentType } from '../../../shared/agent-status-types'
import type { TerminalLayoutSnapshot } from '../../../shared/types'

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'

function entry(paneKey: string, agentType: AgentType | undefined): AgentStatusEntry {
  return {
    state: 'working',
    prompt: '',
    updatedAt: 0,
    stateStartedAt: 0,
    paneKey,
    stateHistory: [],
    ...(agentType ? { agentType } : {})
  }
}

function layout(activeLeafId: string | null): TerminalLayoutSnapshot {
  return { root: null, activeLeafId, expandedLeafId: null }
}

describe('resolveTabAgent', () => {
  it('returns null for a plain terminal (no agent entries)', () => {
    expect(resolveTabAgent({}, layout(LEAF_A), 'tab-1')).toBeNull()
  })

  it('returns the agent in the focused pane (single-pane tab)', () => {
    const map = { [`tab-1:${LEAF_A}`]: entry(`tab-1:${LEAF_A}`, 'claude') }
    expect(resolveTabAgent(map, layout(LEAF_A), 'tab-1')).toBe('claude')
  })

  it('prefers the focused pane when multiple panes run agents', () => {
    const map = {
      [`tab-1:${LEAF_A}`]: entry(`tab-1:${LEAF_A}`, 'claude'),
      [`tab-1:${LEAF_B}`]: entry(`tab-1:${LEAF_B}`, 'codex')
    }
    expect(resolveTabAgent(map, layout(LEAF_B), 'tab-1')).toBe('codex')
  })

  it('exposes focused and sibling hook identity separately', () => {
    const map = {
      [`tab-1:${LEAF_A}`]: entry(`tab-1:${LEAF_A}`, 'claude'),
      [`tab-1:${LEAF_B}`]: entry(`tab-1:${LEAF_B}`, 'codex')
    }
    expect(resolveFocusedTabAgent(map, layout(LEAF_A), 'tab-1')).toBe('claude')
    expect(resolveSiblingTabAgent(map, layout(LEAF_A), 'tab-1')).toBe('codex')
  })

  it('falls back to any agent pane when the focused pane is a plain terminal', () => {
    // Focused leaf A has no entry (it's a shell); the split sibling runs Codex.
    const map = { [`tab-1:${LEAF_B}`]: entry(`tab-1:${LEAF_B}`, 'codex') }
    expect(resolveTabAgent(map, layout(LEAF_A), 'tab-1')).toBe('codex')
  })

  it('resolves via the prefix scan when the layout is missing', () => {
    const map = { [`tab-1:${LEAF_A}`]: entry(`tab-1:${LEAF_A}`, 'droid') }
    expect(resolveTabAgent(map, undefined, 'tab-1')).toBe('droid')
  })

  it('treats same-tab hook identity as focused when the layout is missing', () => {
    const map = { [`tab-1:${LEAF_A}`]: entry(`tab-1:${LEAF_A}`, 'codex') }

    expect(resolveFocusedTabAgent(map, undefined, 'tab-1')).toBe('codex')
    expect(resolveSiblingTabAgent(map, undefined, 'tab-1')).toBeNull()
  })

  it("keeps the terminal glyph for an agent that didn't identify itself", () => {
    const map = { [`tab-1:${LEAF_A}`]: entry(`tab-1:${LEAF_A}`, 'unknown') }
    expect(resolveTabAgent(map, layout(LEAF_A), 'tab-1')).toBeNull()
  })

  it('does not keep a hook-only icon for a completed agent turn', () => {
    const map = {
      [`tab-1:${LEAF_A}`]: {
        ...entry(`tab-1:${LEAF_A}`, 'claude'),
        state: 'done' as const
      }
    }
    expect(resolveTabAgent(map, layout(LEAF_A), 'tab-1')).toBeNull()
  })

  it('exposes the completed hook agent for title disambiguation', () => {
    const map = {
      [`tab-1:${LEAF_A}`]: {
        ...entry(`tab-1:${LEAF_A}`, 'openclaude'),
        state: 'done' as const
      }
    }
    expect(hasCompletedTabAgent(map, 'tab-1')).toBe(true)
    expect(resolveCompletedTabAgent(map, 'tab-1')).toBe('openclaude')
  })

  it('exposes focused and sibling completed hook identity separately', () => {
    const map = {
      [`tab-1:${LEAF_A}`]: {
        ...entry(`tab-1:${LEAF_A}`, 'claude'),
        state: 'done' as const
      },
      [`tab-1:${LEAF_B}`]: {
        ...entry(`tab-1:${LEAF_B}`, 'codex'),
        state: 'done' as const
      }
    }

    expect(resolveFocusedCompletedTabAgent(map, layout(LEAF_A), 'tab-1')).toBe('claude')
    expect(resolveSiblingCompletedTabAgent(map, layout(LEAF_A), 'tab-1')).toBe('codex')
  })

  it('keeps the terminal glyph for an agent Orca has no icon for', () => {
    const map = { [`tab-1:${LEAF_A}`]: entry(`tab-1:${LEAF_A}`, 'totally-custom-agent') }
    expect(resolveTabAgent(map, layout(LEAF_A), 'tab-1')).toBeNull()
  })

  it('does not leak an agent from a tab whose id shares a prefix', () => {
    // 'tab-1' must not match 'tab-10' — the `${tabId}:` delimiter prevents it.
    const map = { [`tab-10:${LEAF_A}`]: entry(`tab-10:${LEAF_A}`, 'claude') }
    expect(resolveTabAgent(map, layout(null), 'tab-1')).toBeNull()
  })
})
