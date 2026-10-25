import { describe, expect, it } from 'vitest'
import {
  EMPTY_FORM,
  getEditingTargetForSshTarget,
  hasAdvancedConnectionValues,
  isSshTargetFormDirty
} from './ssh-target-draft'
import { buildSshTargetSavePayload } from './ssh-target-save-payload'

describe('buildSshTargetSavePayload', () => {
  it('rejects empty hosts', () => {
    const result = buildSshTargetSavePayload({ ...EMPTY_FORM, host: '' })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('Host or SSH config alias is required')
    }
  })

  it('saves remote CLI control on by default and an explicit false when turned off', () => {
    const on = buildSshTargetSavePayload({ ...EMPTY_FORM, host: 'gpu.example.com' })
    const off = buildSshTargetSavePayload({
      ...EMPTY_FORM,
      host: 'gpu.example.com',
      allowRemoteCliControl: false
    })
    if (!off.ok || !on.ok) {
      throw new Error('payload rejected')
    }
    expect(on.payload.target).toMatchObject({ allowRemoteCliControl: true })
    expect(on.payload.updates).toMatchObject({ allowRemoteCliControl: true })
    expect(off.payload.target).toMatchObject({ allowRemoteCliControl: false })
    expect(off.payload.updates).toMatchObject({ allowRemoteCliControl: false })
    expect(hasAdvancedConnectionValues(EMPTY_FORM)).toBe(false)
    expect(hasAdvancedConnectionValues({ ...EMPTY_FORM, allowRemoteCliControl: false })).toBe(true)
  })

  it('shows a host with no saved value as on, and an explicit false as off', () => {
    const host = { id: 'gpu', label: 'gpu', host: 'gpu.example.com', port: 22, username: 'me' }
    expect(getEditingTargetForSshTarget(host).allowRemoteCliControl).toBe(true)
    expect(
      getEditingTargetForSshTarget({ ...host, allowRemoteCliControl: false }).allowRemoteCliControl
    ).toBe(false)
  })

  it('round-trips the remote CLI control opt-in through the edit form', () => {
    const form = getEditingTargetForSshTarget({
      id: 'gpu',
      label: 'gpu',
      host: 'gpu.example.com',
      port: 22,
      username: 'me',
      allowRemoteCliControl: true
    })
    expect(form.allowRemoteCliControl).toBe(true)
    expect(isSshTargetFormDirty({ ...form, allowRemoteCliControl: false }, form)).toBe(true)
  })
})
