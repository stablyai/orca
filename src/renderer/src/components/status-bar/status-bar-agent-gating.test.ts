import { describe, expect, it } from 'vitest'
import {
  isAntigravityStatusBarAvailable,
  isStatusBarItemAvailable
} from './status-bar-agent-gating'

describe('isStatusBarItemAvailable', () => {
  it('shows non-CLI items regardless of detection', () => {
    // Why: ssh, resource-usage, and opencode-go aren't CLIs on PATH, so
    // detection results don't apply.
    expect(isStatusBarItemAvailable('ssh', null)).toBe(true)
    expect(isStatusBarItemAvailable('ssh', [])).toBe(true)
    expect(isStatusBarItemAvailable('resource-usage', [])).toBe(true)
    expect(isStatusBarItemAvailable('ports', [])).toBe(true)
    expect(isStatusBarItemAvailable('opencode-go', [])).toBe(true)
  })

  it('keeps CLI items visible while detection is in flight', () => {
    // Why: pre-detection (null) we don't yet know what the user has, so we
    // don't want a flash of empty status bar on cold start.
    expect(isStatusBarItemAvailable('claude', null)).toBe(true)
    expect(isStatusBarItemAvailable('codex', null)).toBe(true)
    expect(isStatusBarItemAvailable('gemini', null)).toBe(true)
    expect(isStatusBarItemAvailable('antigravity', null)).toBe(true)
    expect(isStatusBarItemAvailable('grok', null)).toBe(true)
  })

  it('hides CLI items not detected on PATH', () => {
    expect(isStatusBarItemAvailable('claude', [])).toBe(false)
    expect(isStatusBarItemAvailable('codex', ['claude'])).toBe(false)
    expect(isStatusBarItemAvailable('gemini', ['claude', 'codex'])).toBe(false)
    expect(isStatusBarItemAvailable('antigravity', ['claude', 'codex'])).toBe(false)
    expect(isStatusBarItemAvailable('grok', ['claude', 'kimi'])).toBe(false)
  })

  it('shows CLI items detected on PATH', () => {
    expect(isStatusBarItemAvailable('claude', ['claude'])).toBe(true)
    expect(isStatusBarItemAvailable('codex', ['codex', 'claude'])).toBe(true)
    expect(isStatusBarItemAvailable('gemini', ['gemini'])).toBe(true)
    expect(isStatusBarItemAvailable('antigravity', ['antigravity'])).toBe(true)
    expect(isStatusBarItemAvailable('grok', ['grok'])).toBe(true)
  })
})

describe('isAntigravityStatusBarAvailable', () => {
  const okSnapshot = { status: 'ok' } as const

  it('shows the slot for a sign-in that lives only on a remote host', () => {
    // Why: `agy` may exist only on the SSH host, so PATH detection alone would hide a bar
    // that a successful read has already proved useful.
    expect(isAntigravityStatusBarAvailable([], okSnapshot)).toBe(true)
  })

  it('shows the slot when the CLI is on PATH even with no snapshot yet', () => {
    expect(isAntigravityStatusBarAvailable(['antigravity'], null)).toBe(true)
  })

  it('hides the slot when neither the CLI nor a reading is present', () => {
    expect(isAntigravityStatusBarAvailable([], null)).toBe(false)
    expect(isAntigravityStatusBarAvailable([], { status: 'unavailable' })).toBe(false)
  })

  it('keeps the pre-detection default so the bar does not flicker on cold start', () => {
    expect(isAntigravityStatusBarAvailable(null, null)).toBe(true)
  })
})
