import { describe, expect, it } from 'vitest'
import {
  HOST_GATED_UI_FIELDS,
  SESSION_GRID_UI_FIELDS_RUNTIME_CAPABILITY,
  SESSION_GRID_VISIBILITY_RUNTIME_CAPABILITY,
  SESSION_GRID_WHEEL_TARGET_RUNTIME_CAPABILITY,
  hasHostGatedUiFields,
  omitUnsupportedHostGatedUiFields
} from './host-gated-ui-fields'
import { PAIRING_LOCAL_UI_FIELDS } from './pairing-local-ui-fields'
import { RUNTIME_CAPABILITIES } from './protocol-version'

describe('host-gated UI fields', () => {
  it('census: every gate names a capability this build advertises', () => {
    for (const gate of HOST_GATED_UI_FIELDS) {
      expect(RUNTIME_CAPABILITIES).toContain(gate.capability)
    }
  })

  it('census: the session grid keys are gated and are not also pairing-local', () => {
    const gate = HOST_GATED_UI_FIELDS.find(
      (entry) => entry.capability === SESSION_GRID_UI_FIELDS_RUNTIME_CAPABILITY
    )
    expect([...(gate?.fields ?? [])]).toEqual([
      'sessionsGridPreset',
      'sessionsGridZoom',
      'sessionsGridShowEmpty',
      'sessionsGridFilter',
      'sessionsGridScrollMode',
      'sessionsGridTabOrder'
    ])
    for (const field of gate?.fields ?? []) {
      expect(PAIRING_LOCAL_UI_FIELDS).not.toContain(field)
    }
  })

  it('census: the wheel target rides its own gate, not the v1 batch an older host accepts', () => {
    const gate = HOST_GATED_UI_FIELDS.find(
      (entry) => entry.capability === SESSION_GRID_WHEEL_TARGET_RUNTIME_CAPABILITY
    )
    expect([...(gate?.fields ?? [])]).toEqual(['sessionsGridWheelTarget'])
    expect(
      omitUnsupportedHostGatedUiFields({ sessionsGridZoom: 1.2, sessionsGridWheelTarget: 'grid' }, [
        SESSION_GRID_UI_FIELDS_RUNTIME_CAPABILITY
      ])
    ).toEqual({ sessionsGridZoom: 1.2 })
  })

  it('census: the visibility keys ride their own gate, not the v1 batch an older host accepts', () => {
    const gate = HOST_GATED_UI_FIELDS.find(
      (entry) => entry.capability === SESSION_GRID_VISIBILITY_RUNTIME_CAPABILITY
    )
    expect([...(gate?.fields ?? [])]).toEqual([
      'sessionsGridHiddenTabIds',
      'sessionsGridStateFilter'
    ])
    for (const field of gate?.fields ?? []) {
      expect(PAIRING_LOCAL_UI_FIELDS).not.toContain(field)
    }
    expect(
      omitUnsupportedHostGatedUiFields(
        {
          sessionsGridZoom: 1.2,
          sessionsGridHiddenTabIds: ['tab-a'],
          sessionsGridStateFilter: 'attention'
        },
        [SESSION_GRID_UI_FIELDS_RUNTIME_CAPABILITY]
      )
    ).toEqual({ sessionsGridZoom: 1.2 })
  })

  it('strips gated keys when the host has not advertised their capability', () => {
    const update = { sidebarWidth: 280, sessionsGridZoom: 1.2, sessionsGridTabOrder: ['a'] }
    expect(omitUnsupportedHostGatedUiFields(update, ['runtime.status.compat.v1'])).toEqual({
      sidebarWidth: 280
    })
  })

  it('strips gated keys when the host could not be asked', () => {
    expect(omitUnsupportedHostGatedUiFields({ sessionsGridZoom: 1.2 }, null)).toEqual({})
    expect(omitUnsupportedHostGatedUiFields({ sessionsGridZoom: 1.2 }, undefined)).toEqual({})
  })

  it('returns the same object when every gate is advertised', () => {
    const update = { sidebarWidth: 280, sessionsGridZoom: 1.2 }
    expect(
      omitUnsupportedHostGatedUiFields(update, [
        SESSION_GRID_UI_FIELDS_RUNTIME_CAPABILITY,
        SESSION_GRID_WHEEL_TARGET_RUNTIME_CAPABILITY,
        SESSION_GRID_VISIBILITY_RUNTIME_CAPABILITY
      ])
    ).toBe(update)
  })

  it('reports whether an update carries any gated key', () => {
    expect(hasHostGatedUiFields({ sidebarWidth: 1 })).toBe(false)
    expect(hasHostGatedUiFields({ sidebarWidth: 1, sessionsGridFilter: 'all' })).toBe(true)
  })
})
