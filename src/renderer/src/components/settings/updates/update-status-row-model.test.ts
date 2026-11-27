import { describe, expect, it } from 'vitest'
import type { UpdateStatus } from '../../../../../shared/updater/update-status-types'
import { getUpdateStatusRowModel, type UpdateStatusRowContext } from './update-status-row-model'

const NOW = Date.parse('2026-11-25T12:00:00Z')
const ctx: UpdateStatusRowContext = { canSkipDelay: true, now: NOW }

function row(status: UpdateStatus, over: Partial<UpdateStatusRowContext> = {}) {
  const model = getUpdateStatusRowModel(status, { ...ctx, ...over })
  return model && [model.line.kind, model.action.kind, model.action.busy, model.details]
}

describe('getUpdateStatusRowModel', () => {
  it('maps the About states to a status line and action', () => {
    expect(row({ state: 'idle' })).toEqual(['none', 'check', false, null])
    expect(row({ state: 'checking' })).toEqual(['checking', 'check', true, null])
    expect(row({ state: 'not-available' })).toEqual(['up-to-date', 'check', false, null])
    expect(row({ state: 'available', version: '9.9.9', changelog: null })).toEqual([
      'available',
      'download',
      false,
      null
    ])
    expect(
      row({ state: 'available', version: '9.9.9', changelog: null, externallyManaged: true })
    ).toEqual(['available', 'check', false, 'externally-managed'])
  })

  it('leaves progress, restart and error to the existing update card', () => {
    expect(row({ state: 'downloading', version: '9.9.9', percent: 42 })).toBeNull()
    expect(row({ state: 'downloaded', version: '9.9.9' })).toBeNull()
    expect(row({ state: 'downloaded', version: '9.9.9', installing: true })).toBeNull()
    expect(row({ state: 'error', message: 'Download interrupted' })).toBeNull()
    expect(row({ state: 'error', message: 'Restart failed', installOnQuit: true })).toBeNull()
  })

  it('offers Skip delay only while a held release is pending and the user owns the delay', () => {
    const held = (availableAt: string): UpdateStatus => ({
      state: 'not-available',
      delayedUpdate: {
        version: '9.9.9',
        releasedAt: '2026-11-20T12:00:00Z',
        availableAt,
        delayDays: 7
      }
    })
    expect(row(held('2026-11-27T12:00:00Z'))).toEqual(['held', 'skip-delay', false, null])
    expect(row(held('2026-11-27T12:00:00Z'), { canSkipDelay: false })).toEqual([
      'held',
      'check',
      false,
      null
    ])
    expect(row(held('2026-11-24T12:00:00Z'))).toEqual(['held-ready', 'check', false, null])
    expect(
      row({
        state: 'not-available',
        unsupportedSystemUpdate: { version: '9.9.9', minimumMacosVersion: '14' }
      })
    ).toEqual(['unsupported-system', 'check', false, 'unsupported-system'])
  })

  it('keeps a modifier-aware Check beside Update or Skip delay', () => {
    const secondary = (status: UpdateStatus) => getUpdateStatusRowModel(status, ctx)?.secondaryCheck
    expect(secondary({ state: 'not-available' })).toBe(false)
    expect(secondary({ state: 'checking' })).toBe(false)
    expect(secondary({ state: 'available', version: '9.9.9', changelog: null })).toBe(true)
    expect(
      secondary({
        state: 'not-available',
        delayedUpdate: {
          version: '9.9.9',
          releasedAt: '2026-11-20T12:00:00Z',
          availableAt: '2026-11-27T12:00:00Z',
          delayDays: 7
        }
      })
    ).toBe(true)
  })

  it('hides release notes for local builds', () => {
    const status: UpdateStatus = { state: 'available', version: '9.9.9', changelog: null }
    expect(getUpdateStatusRowModel(status, ctx)?.notesVersion).toBe('9.9.9')
    expect(getUpdateStatusRowModel({ ...status, source: 'local' }, ctx)?.notesVersion).toBeNull()
  })
})
