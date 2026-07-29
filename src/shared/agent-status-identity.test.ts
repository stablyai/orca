import { describe, it, expect } from 'vitest'
import {
  resolveAgentStatusIdentity,
  shouldSuppressInheritedTerminalStatus
} from './agent-status-identity'
import { AGENT_STATUS_STALE_AFTER_MS } from './agent-status-types'

const NOW = 1_700_000_000_000
const PANE_A = '/private/tmp/tmux-501/default:%0'
const PANE_B = '/private/tmp/tmux-501/default:%1'

describe('resolveAgentStatusIdentity', () => {
  it('adopts the incoming type when nothing is stored', () => {
    expect(resolveAgentStatusIdentity({ incoming: 'opencode', now: NOW })).toEqual({
      agentType: 'opencode',
      inheritedFromActivePane: false
    })
  })

  it('keeps the stored type when the incoming type is unknown', () => {
    expect(
      resolveAgentStatusIdentity({
        existing: { agentType: 'claude', state: 'working', updatedAt: NOW },
        incoming: 'unknown',
        now: NOW
      })
    ).toEqual({ agentType: 'claude', inheritedFromActivePane: false })
  })

  it('protects an active turn from a nested child of a different agent type', () => {
    expect(
      resolveAgentStatusIdentity({
        existing: { agentType: 'claude', state: 'working', updatedAt: NOW },
        incoming: 'codex',
        now: NOW
      })
    ).toEqual({ agentType: 'claude', inheritedFromActivePane: true })
  })

  it('lets the same agent type update its own pane', () => {
    expect(
      resolveAgentStatusIdentity({
        existing: { agentType: 'opencode', state: 'working', updatedAt: NOW },
        incoming: 'opencode',
        now: NOW
      })
    ).toEqual({ agentType: 'opencode', inheritedFromActivePane: false })
  })

  it('protects an active turn from a same-type agent in another tmux pane', () => {
    expect(
      resolveAgentStatusIdentity({
        existing: {
          agentType: 'opencode',
          state: 'working',
          updatedAt: NOW,
          tmuxPaneRef: PANE_A
        },
        incoming: 'opencode',
        incomingTmuxPaneRef: PANE_B,
        now: NOW
      })
    ).toEqual({ agentType: 'opencode', inheritedFromActivePane: true })
  })

  it('treats a matching pane ref as the same agent updating itself', () => {
    expect(
      resolveAgentStatusIdentity({
        existing: {
          agentType: 'opencode',
          state: 'working',
          updatedAt: NOW,
          tmuxPaneRef: PANE_A
        },
        incoming: 'opencode',
        incomingTmuxPaneRef: PANE_A,
        now: NOW
      })
    ).toEqual({ agentType: 'opencode', inheritedFromActivePane: false })
  })

  it('releases the pane to another tmux pane once the stored turn is done', () => {
    expect(
      resolveAgentStatusIdentity({
        existing: {
          agentType: 'opencode',
          state: 'done',
          updatedAt: NOW,
          tmuxPaneRef: PANE_A
        },
        incoming: 'opencode',
        incomingTmuxPaneRef: PANE_B,
        now: NOW
      })
    ).toEqual({ agentType: 'opencode', inheritedFromActivePane: false })
  })

  it('releases the pane to another tmux pane once the stored turn goes stale', () => {
    expect(
      resolveAgentStatusIdentity({
        existing: {
          agentType: 'opencode',
          state: 'working',
          updatedAt: NOW - AGENT_STATUS_STALE_AFTER_MS - 1,
          tmuxPaneRef: PANE_A
        },
        incoming: 'opencode',
        incomingTmuxPaneRef: PANE_B,
        now: NOW
      })
    ).toEqual({ agentType: 'opencode', inheritedFromActivePane: false })
  })

  it('does not infer nesting when only the stored event carried a pane ref', () => {
    expect(
      resolveAgentStatusIdentity({
        existing: {
          agentType: 'opencode',
          state: 'working',
          updatedAt: NOW,
          tmuxPaneRef: PANE_A
        },
        incoming: 'opencode',
        now: NOW
      })
    ).toEqual({ agentType: 'opencode', inheritedFromActivePane: false })
  })

  it('does not infer nesting when only the incoming event carried a pane ref', () => {
    expect(
      resolveAgentStatusIdentity({
        existing: { agentType: 'opencode', state: 'working', updatedAt: NOW },
        incoming: 'opencode',
        incomingTmuxPaneRef: PANE_B,
        now: NOW
      })
    ).toEqual({ agentType: 'opencode', inheritedFromActivePane: false })
  })
})

describe('tmux sibling pane status collisions', () => {
  // Why: reproduces the reported flow — two OpenCode instances in one tmux
  // client, where finishing in window 1 blanked the running turn in window 0.
  const resolveSuppression = (args: {
    existingTmuxPaneRef?: string
    incomingTmuxPaneRef?: string
  }): boolean => {
    const identity = resolveAgentStatusIdentity({
      existing: {
        agentType: 'opencode',
        state: 'working',
        updatedAt: NOW,
        tmuxPaneRef: args.existingTmuxPaneRef
      },
      incoming: 'opencode',
      incomingTmuxPaneRef: args.incomingTmuxPaneRef,
      now: NOW
    })
    return shouldSuppressInheritedTerminalStatus({
      inheritedFromActivePane: identity.inheritedFromActivePane,
      incomingState: 'done'
    })
  }

  it('drops a sibling pane completion while the visible pane is working', () => {
    expect(resolveSuppression({ existingTmuxPaneRef: PANE_A, incomingTmuxPaneRef: PANE_B })).toBe(
      true
    )
  })

  it('still applies the completion that belongs to the working pane', () => {
    expect(resolveSuppression({ existingTmuxPaneRef: PANE_A, incomingTmuxPaneRef: PANE_A })).toBe(
      false
    )
  })

  it('leaves non-tmux panes on the previous behavior', () => {
    expect(resolveSuppression({})).toBe(false)
  })
})
