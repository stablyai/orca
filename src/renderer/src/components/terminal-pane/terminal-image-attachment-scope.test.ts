import { describe, expect, it } from 'vitest'
import { terminalImageAttachmentScope } from './terminal-image-attachment-scope'
import type { PaneAgentSessionIdState } from './pane-agent-session-id'

function state(): PaneAgentSessionIdState {
  return {
    paneForegroundAgentByPaneKey: {
      pane: { agent: 'codex', routingTrusted: true, shellForeground: false }
    },
    agentStatusByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {}
  }
}

describe('terminal attachment preview capability', () => {
  it('requires a connected PTY and confirmed Codex authority', () => {
    const evidence = state()
    expect(terminalImageAttachmentScope(evidence, 'pane', 'pty')).toBe('pty:')
    expect(terminalImageAttachmentScope(evidence, 'pane', null)).toBeNull()
    expect(terminalImageAttachmentScope(evidence, 'other-pane', 'pty')).toBeNull()
    evidence.paneForegroundAgentByPaneKey.pane = { agent: 'codex', shellForeground: false }
    expect(terminalImageAttachmentScope(evidence, 'pane', 'pty')).toBeNull()
  })
  it('preserves other CLI paste flows and rejects exited or revoked Codex authority', () => {
    const evidence = state()
    evidence.paneForegroundAgentByPaneKey.pane = {
      agent: 'claude',
      routingTrusted: true,
      shellForeground: false
    }
    expect(terminalImageAttachmentScope(evidence, 'pane', 'pty')).toBeNull()
    evidence.paneForegroundAgentByPaneKey.pane = {
      agent: 'codex',
      routingTrusted: true,
      shellForeground: true
    }
    expect(terminalImageAttachmentScope(evidence, 'pane', 'pty')).toBeNull()
    evidence.paneForegroundAgentByPaneKey.pane = {
      agent: 'codex',
      routingTrusted: true,
      shellForeground: false,
      routingRevoked: true
    }
    expect(terminalImageAttachmentScope(evidence, 'pane', 'pty')).toBeNull()
  })
  it('changes scope when the provider session changes', () => {
    const evidence = state()
    evidence.agentStatusByPaneKey.pane = {
      state: 'waiting',
      prompt: '',
      updatedAt: 1,
      stateStartedAt: 1,
      paneKey: 'pane',
      stateHistory: [],
      providerSession: { key: 'session_id', id: 'first' }
    }
    expect(terminalImageAttachmentScope(evidence, 'pane', 'pty')).toBe('pty:first')
    const entry = evidence.agentStatusByPaneKey.pane
    if (!entry) {
      throw new Error('Missing test evidence')
    }
    entry.providerSession = { key: 'session_id', id: 'second' }
    expect(terminalImageAttachmentScope(evidence, 'pane', 'pty')).toBe('pty:second')
  })
  it('changes scope when the PTY is replaced', () => {
    expect(terminalImageAttachmentScope(state(), 'pane', 'first')).not.toBe(
      terminalImageAttachmentScope(state(), 'pane', 'second')
    )
  })
})
