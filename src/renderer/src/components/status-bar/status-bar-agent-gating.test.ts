import { describe, expect, it } from 'vitest'
import { isStatusBarItemAvailable } from './status-bar-agent-gating'

describe('isStatusBarItemAvailable', () => {
  it('shows non-CLI items regardless of detection', () => {
    expect(isStatusBarItemAvailable('ssh', null)).toBe(true)
    expect(isStatusBarItemAvailable('ssh', [])).toBe(true)
    expect(isStatusBarItemAvailable('resource-usage', [])).toBe(true)
    expect(isStatusBarItemAvailable('ports', [])).toBe(true)
    expect(isStatusBarItemAvailable('opencode-go', [])).toBe(true)
  })

  it('keeps CLI items visible while detection is in flight', () => {
    // Unknown detection preserves items to avoid a cold-start flash.
    expect(isStatusBarItemAvailable('claude', null)).toBe(true)
    expect(isStatusBarItemAvailable('codex', null)).toBe(true)
    expect(isStatusBarItemAvailable('gemini', null)).toBe(true)
    expect(isStatusBarItemAvailable('antigravity', null)).toBe(true)
    expect(isStatusBarItemAvailable('grok', null)).toBe(true)
    expect(isStatusBarItemAvailable('zcode', null)).toBe(true)
  })

  it('hides CLI items not detected on PATH', () => {
    expect(isStatusBarItemAvailable('claude', [])).toBe(false)
    expect(isStatusBarItemAvailable('codex', ['claude'])).toBe(false)
    expect(isStatusBarItemAvailable('gemini', ['claude', 'codex'])).toBe(false)
    expect(isStatusBarItemAvailable('antigravity', ['claude', 'codex'])).toBe(false)
    expect(isStatusBarItemAvailable('grok', ['claude', 'kimi'])).toBe(false)
    expect(isStatusBarItemAvailable('zcode', ['claude', 'kimi'])).toBe(false)
  })

  it('shows CLI items detected on PATH', () => {
    expect(isStatusBarItemAvailable('claude', ['claude'])).toBe(true)
    expect(isStatusBarItemAvailable('codex', ['codex', 'claude'])).toBe(true)
    expect(isStatusBarItemAvailable('gemini', ['gemini'])).toBe(true)
    expect(isStatusBarItemAvailable('antigravity', ['antigravity'])).toBe(true)
    expect(isStatusBarItemAvailable('grok', ['grok'])).toBe(true)
    expect(isStatusBarItemAvailable('zcode', ['zcode'])).toBe(true)
  })
})
