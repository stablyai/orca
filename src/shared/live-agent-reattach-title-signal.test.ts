import { describe, expect, it } from 'vitest'
import {
  isNativeStatuslessAgentReattachTitle,
  titleSignalsLiveAgentReattach
} from './live-agent-reattach-title-signal'

describe('isNativeStatuslessAgentReattachTitle', () => {
  it('accepts Cursor native titles that carry no status glyphs', () => {
    expect(isNativeStatuslessAgentReattachTitle('Cursor Agent')).toBe(true)
    expect(isNativeStatuslessAgentReattachTitle('  cursor agent  ')).toBe(true)
  })

  // Why: OpenCode's OSC identity is `OC | <task>` without "opencode" tokens or
  // status glyphs. Missing this signal disarms mouse on reattach (#11123).
  it('accepts OpenCode native OC | titles', () => {
    expect(isNativeStatuslessAgentReattachTitle('OC | Native Stable Session')).toBe(true)
    expect(isNativeStatuslessAgentReattachTitle('OC | Understand about the plugin')).toBe(true)
    expect(isNativeStatuslessAgentReattachTitle('tmux | OC | ses_123')).toBe(true)
  })

  it('rejects shells, lookalikes, and status-bearing agent names', () => {
    expect(isNativeStatuslessAgentReattachTitle('')).toBe(false)
    expect(isNativeStatuslessAgentReattachTitle('zsh')).toBe(false)
    expect(isNativeStatuslessAgentReattachTitle('OpenCode ready')).toBe(false)
    expect(isNativeStatuslessAgentReattachTitle('opencode')).toBe(false)
    expect(isNativeStatuslessAgentReattachTitle('ssh devin@host')).toBe(false)
    expect(isNativeStatuslessAgentReattachTitle('oc | lowercase lookalike')).toBe(false)
    expect(isNativeStatuslessAgentReattachTitle('OC |')).toBe(false)
    // Why: native OpenCode always spaces `OC |`; compact `OC|x` is another tool.
    expect(isNativeStatuslessAgentReattachTitle('OC|compact-session')).toBe(false)
    expect(isNativeStatuslessAgentReattachTitle('Codex ready')).toBe(false)
  })
})

describe('titleSignalsLiveAgentReattach', () => {
  it('accepts any non-null status detection result', () => {
    expect(titleSignalsLiveAgentReattach('Codex ready', 'idle')).toBe(true)
    expect(titleSignalsLiveAgentReattach('opencode', 'working')).toBe(true)
    expect(titleSignalsLiveAgentReattach('plain shell mentioning nothing', 'idle')).toBe(true)
  })

  it('accepts statusless native titles when status detection is null', () => {
    expect(titleSignalsLiveAgentReattach('Cursor Agent', null)).toBe(true)
    expect(titleSignalsLiveAgentReattach('OC | Native Stable Session', null)).toBe(true)
  })

  it('rejects null-status shells and loose agent-name tokens', () => {
    expect(titleSignalsLiveAgentReattach('', null)).toBe(false)
    expect(titleSignalsLiveAgentReattach('zsh', null)).toBe(false)
    // Why: getAgentLabel matches "devin"; reattach must not preserve modes on
    // status-null shell titles (caller status detection stays the gate).
    expect(titleSignalsLiveAgentReattach('ssh devin@host', null)).toBe(false)
    expect(titleSignalsLiveAgentReattach('oc | lowercase lookalike', null)).toBe(false)
  })
})
