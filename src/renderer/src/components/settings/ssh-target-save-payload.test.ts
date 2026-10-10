import { describe, expect, it } from 'vitest'
import { EMPTY_FORM, getEditingTargetForSshTarget, isSshTargetFormDirty } from './ssh-target-draft'
import { buildSshTargetSavePayload } from './ssh-target-save-payload'

describe('buildSshTargetSavePayload', () => {
  it('rejects empty hosts', () => {
    const result = buildSshTargetSavePayload({ ...EMPTY_FORM, host: '' })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('Host or SSH config alias is required')
    }
  })

  it('keeps remote CLI control off unless the user opts this host in, and clears it on update', () => {
    const off = buildSshTargetSavePayload({ ...EMPTY_FORM, host: 'gpu.example.com' })
    const on = buildSshTargetSavePayload({
      ...EMPTY_FORM,
      host: 'gpu.example.com',
      allowRemoteCliControl: true
    })
    if (!off.ok || !on.ok) {
      throw new Error('payload rejected')
    }
    expect(off.payload.target).not.toHaveProperty('allowRemoteCliControl')
    expect(off.payload.updates).toHaveProperty('allowRemoteCliControl', undefined)
    expect(on.payload.target).toMatchObject({ allowRemoteCliControl: true })
    expect(on.payload.updates).toMatchObject({ allowRemoteCliControl: true })
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
