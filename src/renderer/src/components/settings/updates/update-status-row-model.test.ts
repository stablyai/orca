import { describe, expect, it } from 'vitest'
import type { UpdateStatus } from '../../../../../shared/updater/update-status-types'
import { getUpdateStatusRowModel, type UpdateStatusRowContext } from './update-status-row-model'

const NOW = Date.parse('2026-11-25T12:00:00Z')
const ctx: UpdateStatusRowContext = {
  showManualRestart: false,
  retainedVersion: null,
  canSkipDelay: true,
  now: NOW
}

function row(status: UpdateStatus, over: Partial<UpdateStatusRowContext> = {}) {
  const model = getUpdateStatusRowModel(status, { ...ctx, ...over })
  return [model.line.kind, model.action.kind, model.action.disabled, model.details] as const
}

describe('getUpdateStatusRowModel', () => {
  // The About row has one button; each updater state must map to exactly one action.
  it('maps every updater state to one status line and one action', () => {
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
    expect(row({ state: 'downloading', version: '9.9.9', percent: 42 })).toEqual([
      'downloading',
      'progress',
      false,
      null
    ])
    expect(row({ state: 'downloaded', version: '9.9.9' })).toEqual([
      'ready',
      'restart',
      false,
      null
    ])
    expect(row({ state: 'downloaded', version: '9.9.9', installing: true })).toEqual([
      'installing',
      'restart',
      true,
      null
    ])
    expect(
      row({ state: 'downloaded', version: '9.9.9', installing: true, automaticDownload: true })
    ).toEqual(['installing', 'none', false, null])
  })

  it('retries the failed step and keeps raw errors behind details', () => {
    expect(row({ state: 'error', message: 'boom' })).toEqual([
      'failed',
      'retry-check',
      false,
      'message'
    ])
    expect(row({ state: 'error', message: 'boom', retryAction: 'install' })).toEqual([
      'failed',
      'retry-install',
      false,
      'message'
    ])
    expect(
      row({ state: 'error', message: 'boom', retryAction: 'install', retryable: false })
    ).toEqual(['failed', 'retry-check', false, 'message'])
    expect(row({ state: 'error', message: 'stuck', messageCode: 'macStagingTimeout' })).toEqual([
      'failed',
      'retry-check',
      true,
      'message'
    ])
    expect(
      row({
        state: 'error',
        message: 'blocked',
        retryAction: 'install',
        installBlock: { reason: 'busy', instances: [] }
      })
    ).toEqual(['install-blocked', 'retry-install', false, 'install-block'])
    expect(getUpdateStatusRowModel({ state: 'error', message: 'x' }, ctx).line).toEqual({
      kind: 'failed',
      phase: 'check'
    })
    expect(
      getUpdateStatusRowModel(
        { state: 'error', message: 'x' },
        { ...ctx, retainedVersion: '9.9.9' }
      ).line
    ).toEqual({ kind: 'failed', phase: 'update' })
  })

  // A host that reports the failed step is believed even without a version; only older hosts
  // that omit it fall back to inferring the step from a known target.
  it('takes the failed step from the host before inferring it from the version', () => {
    for (const failurePhase of ['download', 'install'] as const) {
      expect(
        getUpdateStatusRowModel({ state: 'error', message: 'x', failurePhase }, ctx).line
      ).toEqual({ kind: 'failed', phase: 'update' })
    }
    expect(getUpdateStatusRowModel({ state: 'error', message: 'x' }, ctx).line).toEqual({
      kind: 'failed',
      phase: 'check'
    })
  })

  it('offers Quit when macOS staged the update for a normal quit, keeping a failure readable', () => {
    expect(
      row(
        { state: 'error', message: 'restart failed', installOnQuit: true },
        { showManualRestart: true }
      )
    ).toEqual(['install-on-quit', 'quit', false, 'message'])
    expect(
      row(
        { state: 'downloaded', version: '9.9.9', installOnQuit: true },
        { showManualRestart: true }
      )
    ).toEqual(['install-on-quit', 'quit', false, null])
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

  it('keeps a modifier-aware Check beside every primary that is not Check', () => {
    const secondary = (status: UpdateStatus, over: Partial<UpdateStatusRowContext> = {}) =>
      getUpdateStatusRowModel(status, { ...ctx, ...over }).secondaryCheck
    expect(secondary({ state: 'not-available' })).toBeNull()
    expect(secondary({ state: 'checking' })).toBeNull()
    expect(secondary({ state: 'downloading', version: '9.9.9', percent: 1 })).toBeNull()
    expect(secondary({ state: 'downloaded', version: '9.9.9', installing: true })).toBeNull()
    expect(secondary({ state: 'available', version: '9.9.9', changelog: null })).toEqual({
      disabled: false
    })
    expect(secondary({ state: 'downloaded', version: '9.9.9' })).toEqual({ disabled: false })
    expect(secondary({ state: 'error', message: 'x', retryAction: 'install' })).toEqual({
      disabled: false
    })
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
    ).toEqual({ disabled: false })
    expect(
      secondary(
        { state: 'error', message: 'x', messageCode: 'macStagingTimeout', installOnQuit: true },
        { showManualRestart: true }
      )
    ).toEqual({ disabled: true })
  })

  it('hides release notes for local builds', () => {
    const status: UpdateStatus = { state: 'downloaded', version: '9.9.9' }
    expect(getUpdateStatusRowModel(status, ctx).notesVersion).toBe('9.9.9')
    expect(getUpdateStatusRowModel({ ...status, source: 'local' }, ctx).notesVersion).toBeNull()
  })
})
