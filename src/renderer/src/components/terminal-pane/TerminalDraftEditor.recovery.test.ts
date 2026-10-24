import { describe, expect, it } from 'vitest'
import { resolveDraftRecovery } from './terminal-draft-recovery'

describe('resolveDraftRecovery', () => {
  it('opens the terminal version when no local copy exists', () => {
    expect(
      resolveDraftRecovery({ local: undefined, remoteText: 'remote', remoteToken: 'token-1' })
    ).toEqual({ text: 'remote', baseToken: 'token-1', dirty: false, conflict: false })
  })

  it('restores a parked local copy when the terminal still matches its origin', () => {
    expect(
      resolveDraftRecovery({
        local: { text: 'local edit', remoteText: 'remote' },
        remoteText: 'remote',
        remoteToken: 'token-1'
      })
    ).toEqual({ text: 'local edit', baseToken: 'token-1', dirty: true, conflict: false })
  })

  it('treats a parked copy whose text already matches the terminal as clean', () => {
    expect(
      resolveDraftRecovery({
        local: { text: 'already saved', remoteText: 'remote before close' },
        remoteText: 'already saved',
        remoteToken: 'token-2'
      })
    ).toEqual({
      text: 'already saved',
      baseToken: 'token-2',
      dirty: false,
      conflict: false
    })
  })

  it('surfaces a conflict when the terminal changed while the editor was closed', () => {
    expect(
      resolveDraftRecovery({
        local: { text: 'local edit', remoteText: 'remote before close' },
        remoteText: 'changed elsewhere',
        remoteToken: 'token-2'
      })
    ).toEqual({
      text: 'local edit',
      baseToken: 'token-2',
      dirty: true,
      conflict: true
    })
  })
})
