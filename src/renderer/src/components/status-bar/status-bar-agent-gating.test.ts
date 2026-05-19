import { describe, expect, it } from 'vitest'
import { isStatusBarItemAvailable } from './status-bar-agent-gating'

describe('isStatusBarItemAvailable', () => {
  it('shows non-CLI items regardless of detection', () => {
    // Why: ssh, resource-usage, and opencode-go aren't CLIs on PATH, so
    // detection results don't apply.
    expect(isStatusBarItemAvailable('ssh', null)).toBe(true)
    expect(isStatusBarItemAvailable('ssh', [])).toBe(true)
    expect(isStatusBarItemAvailable('resource-usage', [])).toBe(true)
    expect(isStatusBarItemAvailable('opencode-go', [])).toBe(true)
  })

  it('keeps CLI items visible while detection is in flight', () => {
    // Why: pre-detection (null) we don't yet know what the user has, so we
    // don't want a flash of empty status bar on cold start.
    expect(isStatusBarItemAvailable('claude', null)).toBe(true)
    expect(isStatusBarItemAvailable('codex', null)).toBe(true)
    expect(isStatusBarItemAvailable('gemini', null)).toBe(true)
  })

  it('hides CLI items not detected on PATH', () => {
    expect(isStatusBarItemAvailable('claude', [])).toBe(false)
    expect(isStatusBarItemAvailable('codex', ['claude'])).toBe(false)
    expect(isStatusBarItemAvailable('gemini', ['claude', 'codex'])).toBe(false)
  })

  it('shows CLI items detected on PATH', () => {
    expect(isStatusBarItemAvailable('claude', ['claude'])).toBe(true)
    expect(isStatusBarItemAvailable('codex', ['codex', 'claude'])).toBe(true)
    expect(isStatusBarItemAvailable('gemini', ['gemini'])).toBe(true)
  })
})
