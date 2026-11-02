import { describe, expect, it } from 'vitest'
import { admitPluginPanelCall, createPluginPanelCallAdmission } from './plugin-panel-call-admission'

describe('createPluginPanelCallAdmission', () => {
  it('shares the rate budget across calls for one plugin', () => {
    let now = 0
    const admission = createPluginPanelCallAdmission({
      limits: { maxMessages: 2, perMs: 1_000 },
      now: () => now
    })

    expect(admission.admit('samples.one', { method: 'one' })).toBeNull()
    expect(admission.admit('samples.one', { method: 'two' })).toBeNull()
    expect(admission.admit('samples.one', { method: 'three' })).toBe('rate_limited')
    expect(admission.admit('samples.two', { method: 'one' })).toBeNull()

    now = 1_000
    expect(admission.admit('samples.one', { method: 'four' })).toBeNull()
  })

  it('rejects oversized calls and can revoke a plugin budget', () => {
    const admission = createPluginPanelCallAdmission({
      limits: { maxBytes: 32, maxMessages: 1, perMs: 10_000 },
      now: () => 0
    })

    expect(admission.admit('samples.one', { payload: 'x'.repeat(64) })).toBe('oversized')
    expect(admission.admit('samples.one', {})).toBe('rate_limited')
    admission.clear('samples.one')
    expect(admission.admit('samples.one', {})).toBeNull()
  })

  it('tells a rate-limited caller how long to wait', () => {
    let now = 0
    const admission = createPluginPanelCallAdmission({
      limits: { maxMessages: 1, perMs: 10_000 },
      now: () => now
    })

    expect(admitPluginPanelCall(admission, 'samples.one', {})).toBeNull()
    now = 4_000
    expect(admitPluginPanelCall(admission, 'samples.one', {})).toEqual({
      ok: false,
      code: 'rate_limited',
      error: 'too many panel requests',
      retryAfterMs: 6_000
    })
    expect(admission.retryAfterMs('samples.unknown')).toBe(0)
  })
})
