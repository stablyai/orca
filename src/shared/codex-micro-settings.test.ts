import { describe, expect, it } from 'vitest'
import { DEFAULT_CODEX_MICRO_SETTINGS, normalizeCodexMicroSettings } from './codex-micro-settings'

describe('DEFAULT_CODEX_MICRO_SETTINGS', () => {
  it('defaults to disabled ownership and output', () => {
    expect(DEFAULT_CODEX_MICRO_SETTINGS.enabled).toBe(false)
    expect(DEFAULT_CODEX_MICRO_SETTINGS.lightingEnabled).toBe(false)
    expect(DEFAULT_CODEX_MICRO_SETTINGS.brightness).toBe(100)
    expect(DEFAULT_CODEX_MICRO_SETTINGS.idleTimeoutSeconds).toBe(300)
    expect(DEFAULT_CODEX_MICRO_SETTINGS.dialMode).toBe('navigate')
  })

  it('maps only the capture-approved controls to safe existing actions', () => {
    expect(DEFAULT_CODEX_MICRO_SETTINGS.mappings).toEqual({
      AG00: 'worktree.navigateUp',
      AG01: 'worktree.navigateDown',
      ACT06: 'worktree.history.back',
      ACT07: 'worktree.history.forward',
      ACT08: 'sidebar.left.toggle',
      ENC_CC: 'tab.previousRecent',
      ENC_CW: 'tab.nextAllTypes',
      ENC_CLK: 'worktree.palette'
    })
  })

  it('leaves unlisted controls unassigned', () => {
    for (const control of ['AG02', 'AG03', 'AG04', 'AG05', 'ACT09', 'ACT10', 'ACT11', 'ACT12']) {
      expect(DEFAULT_CODEX_MICRO_SETTINGS.mappings).not.toHaveProperty(control)
    }
  })
})

describe('normalizeCodexMicroSettings', () => {
  it('migrates missing settings to the default shape', () => {
    expect(normalizeCodexMicroSettings(undefined)).toEqual(DEFAULT_CODEX_MICRO_SETTINGS)
  })

  it('migrates non-object input to the default shape', () => {
    expect(normalizeCodexMicroSettings(null)).toEqual(DEFAULT_CODEX_MICRO_SETTINGS)
    expect(normalizeCodexMicroSettings('nope')).toEqual(DEFAULT_CODEX_MICRO_SETTINGS)
    expect(normalizeCodexMicroSettings(42)).toEqual(DEFAULT_CODEX_MICRO_SETTINGS)
  })

  it('preserves valid boolean and enum fields', () => {
    const result = normalizeCodexMicroSettings({
      enabled: true,
      lightingEnabled: true,
      dialMode: 'scroll'
    })
    expect(result.enabled).toBe(true)
    expect(result.lightingEnabled).toBe(true)
    expect(result.dialMode).toBe('scroll')
  })

  it('rejects invalid enabled/lightingEnabled/dialMode values back to defaults', () => {
    const result = normalizeCodexMicroSettings({
      enabled: 'yes',
      lightingEnabled: 1,
      dialMode: 'spin'
    })
    expect(result.enabled).toBe(false)
    expect(result.lightingEnabled).toBe(false)
    expect(result.dialMode).toBe('navigate')
  })

  it('clamps brightness to 0..100', () => {
    expect(normalizeCodexMicroSettings({ brightness: -5 }).brightness).toBe(0)
    expect(normalizeCodexMicroSettings({ brightness: 500 }).brightness).toBe(100)
    expect(normalizeCodexMicroSettings({ brightness: 42 }).brightness).toBe(42)
  })

  it('defaults brightness when not a finite number', () => {
    expect(normalizeCodexMicroSettings({ brightness: 'bright' }).brightness).toBe(100)
    expect(normalizeCodexMicroSettings({ brightness: Number.NaN }).brightness).toBe(100)
  })

  it('clamps idleTimeoutSeconds to the documented bounded range', () => {
    expect(normalizeCodexMicroSettings({ idleTimeoutSeconds: 0 }).idleTimeoutSeconds).toBe(10)
    expect(normalizeCodexMicroSettings({ idleTimeoutSeconds: -100 }).idleTimeoutSeconds).toBe(10)
    expect(normalizeCodexMicroSettings({ idleTimeoutSeconds: 999999 }).idleTimeoutSeconds).toBe(
      3600
    )
    expect(normalizeCodexMicroSettings({ idleTimeoutSeconds: 120 }).idleTimeoutSeconds).toBe(120)
  })

  it('defaults idleTimeoutSeconds when not a finite number', () => {
    expect(normalizeCodexMicroSettings({ idleTimeoutSeconds: 'later' }).idleTimeoutSeconds).toBe(
      300
    )
  })

  it('rejects mapping values that are not KeybindingActionId strings', () => {
    const result = normalizeCodexMicroSettings({
      mappings: { AG00: 'not.a.real.action' }
    })
    expect(result.mappings).not.toHaveProperty('AG00')
  })

  it('drops mapping keys that are not CodexMicroControlId values', () => {
    const result = normalizeCodexMicroSettings({
      mappings: { NOT_A_CONTROL: 'worktree.palette' }
    })
    expect(result.mappings).toEqual({})
  })

  it('preserves explicit unassigned controls instead of re-filling defaults', () => {
    const result = normalizeCodexMicroSettings({
      mappings: { AG00: null, ACT06: 'worktree.history.forward' }
    })
    expect(result.mappings).not.toHaveProperty('AG00')
    expect(result.mappings).toEqual({ ACT06: 'worktree.history.forward' })
  })

  it('falls back to default mappings only when mappings is entirely absent', () => {
    const result = normalizeCodexMicroSettings({ enabled: true })
    expect(result.mappings).toEqual(DEFAULT_CODEX_MICRO_SETTINGS.mappings)
  })

  it('accepts a full valid custom mapping unchanged', () => {
    const custom = {
      AG02: 'worktree.navigateUp',
      ACT09: 'sidebar.left.toggle'
    }
    const result = normalizeCodexMicroSettings({ mappings: custom })
    expect(result.mappings).toEqual(custom)
  })
})
