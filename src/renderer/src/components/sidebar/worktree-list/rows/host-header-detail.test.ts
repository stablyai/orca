import { describe, expect, it } from 'vitest'
import { getHostHeaderDetail } from './host-header-detail'

const runtimeRow = { kind: 'runtime', detail: 'Orca server' } as const

describe('getHostHeaderDetail', () => {
  it('asks for a re-pair when the host revoked this client', () => {
    expect(
      getHostHeaderDetail({
        ...runtimeRow,
        health: 'blocked',
        blockedReason: 'access-revoked'
      })
    ).toEqual({ text: 'Re-pair required', isWarning: true })
  })

  it('keeps the update label for an incompatible or unlabeled block', () => {
    expect(
      getHostHeaderDetail({
        ...runtimeRow,
        health: 'blocked',
        blockedReason: 'incompatible'
      })
    ).toEqual({ text: 'Update required', isWarning: true })
    expect(getHostHeaderDetail({ ...runtimeRow, health: 'blocked' })).toEqual({
      text: 'Update required',
      isWarning: true
    })
  })
})
