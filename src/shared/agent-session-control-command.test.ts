import { describe, expect, it } from 'vitest'
import { isAgentSessionControlCommand } from './agent-session-control-command'

describe('isAgentSessionControlCommand', () => {
  it('allows only catalog-backed commands for the selected harness', () => {
    expect(isAgentSessionControlCommand('claude', '/model opus')).toBe(true)
    expect(isAgentSessionControlCommand('claude', '/effort xhigh')).toBe(true)
    expect(isAgentSessionControlCommand('codex', '/model')).toBe(true)
    expect(isAgentSessionControlCommand('codex', '/effort high')).toBe(false)
    expect(isAgentSessionControlCommand('claude', '/help')).toBe(false)
    expect(isAgentSessionControlCommand('grok', '/model')).toBe(false)
  })

  it('admits a safe custom Claude model id without admitting extra input', () => {
    expect(isAgentSessionControlCommand('claude', '/model claude-opus-5[1m]')).toBe(true)
    expect(isAgentSessionControlCommand('claude', '/model future.model-v2')).toBe(true)
    expect(isAgentSessionControlCommand('claude', '/model opus; /help')).toBe(false)
    expect(isAgentSessionControlCommand('claude', '/model model with spaces')).toBe(false)
  })
})
