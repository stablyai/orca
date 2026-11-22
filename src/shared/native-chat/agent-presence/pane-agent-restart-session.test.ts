import { describe, expect, it } from 'vitest'
import { pickPaneAgentRestartSession } from './pane-agent-restart-session'

describe('pickPaneAgentRestartSession', () => {
  it('resumes the conversation the chat showed, not a newer one the pane started', () => {
    const newer = { key: 'session_id' as const, id: 'new', permissionMode: 'plan' as const }
    const shown = { key: 'session_id' as const, id: 'old', transcriptPath: '/t/old.jsonl' }
    const named = { key: 'session_id' as const, id: 'old' }
    expect(pickPaneAgentRestartSession([newer, null, shown], 'old', named)).toBe(shown)
    expect(pickPaneAgentRestartSession([newer], 'old', named)).toBe(named)
    expect(pickPaneAgentRestartSession([null, newer], null, null)).toBe(newer)
  })
})
