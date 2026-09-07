import { describe, expect, it } from 'vitest'
import { createPluginPanelCallAdmission } from './plugin-panel-call-admission'

describe('createPluginPanelCallAdmission', () => {
  it('shares the rate budget across panel sessions for one plugin', () => {
    let now = 0
    const admission = createPluginPanelCallAdmission({
      limits: { maxMessages: 2, perMs: 1_000 },
      now: () => now
    })

    expect(admission.admit('orca-samples.one', { method: 'one' })).toBeNull()
    expect(admission.admit('orca-samples.one', { method: 'two' })).toBeNull()
    expect(admission.admit('orca-samples.one', { method: 'three' })).toBe('rate_limited')
    expect(admission.admit('orca-samples.two', { method: 'one' })).toBeNull()

    now = 1_000
    expect(admission.admit('orca-samples.one', { method: 'four' })).toBeNull()
  })

  it('rejects oversized calls and can revoke a plugin budget', () => {
    const admission = createPluginPanelCallAdmission({
      limits: { maxBytes: 32, maxMessages: 1, perMs: 10_000 },
      now: () => 0
    })

    expect(admission.admit('orca-samples.one', { payload: 'x'.repeat(64) })).toBe('oversized')
    expect(admission.admit('orca-samples.one', {})).toBe('rate_limited')
    admission.clear('orca-samples.one')
    expect(admission.admit('orca-samples.one', {})).toBeNull()
  })
})
