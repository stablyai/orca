import { describe, expect, it } from 'vitest'
import {
  applyHostRename,
  clearHostRename,
  getHostDisplayLabelOverride,
  resolveHostRemoval
} from './host-rename-remove'

describe('host rename helpers', () => {
  it('reads the current display-label override', () => {
    const settings = { hostSettingOverrides: { 'ssh:box': { displayLabel: 'Box' } } }
    expect(getHostDisplayLabelOverride(settings, 'ssh:box')).toBe('Box')
    expect(getHostDisplayLabelOverride(settings, 'ssh:other')).toBeUndefined()
  })

  it('applies a rename', () => {
    expect(applyHostRename({ hostSettingOverrides: {} }, 'ssh:box', 'Renamed')).toEqual({
      'ssh:box': { displayLabel: 'Renamed' }
    })
  })

  it('clears the override when renamed to blank', () => {
    const settings = { hostSettingOverrides: { 'ssh:box': { displayLabel: 'Box' } } }
    expect(applyHostRename(settings, 'ssh:box', '   ')).toEqual({})
  })

  it('resets a rename to the derived label', () => {
    const settings = {
      hostSettingOverrides: {
        'ssh:box': { displayLabel: 'Box', defaultWorktreeLocation: '/w' }
      }
    }
    expect(clearHostRename(settings, 'ssh:box')).toEqual({
      'ssh:box': { defaultWorktreeLocation: '/w' }
    })
  })
})

describe('resolveHostRemoval', () => {
  it('resolves an ssh host to its target id', () => {
    expect(resolveHostRemoval('ssh:box')).toEqual({ kind: 'ssh', targetId: 'box' })
  })

  it('resolves a runtime host to its environment id', () => {
    expect(resolveHostRemoval('runtime:env-1')).toEqual({
      kind: 'runtime',
      environmentId: 'env-1'
    })
  })

  it('returns null for the local host', () => {
    expect(resolveHostRemoval('local')).toBeNull()
  })
})
