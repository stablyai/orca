import { describe, expect, it } from 'vitest'
import {
  getSshConfigImportOutcome,
  getSshConfigImportTruncationNotice
} from './ssh-config-import-truncation-notice'

describe('getSshConfigImportTruncationNotice', () => {
  it('returns nothing when the import dropped no configuration', () => {
    expect(getSshConfigImportTruncationNotice(null)).toBeNull()
    expect(getSshConfigImportTruncationNotice(undefined)).toBeNull()
    expect(getSshConfigImportTruncationNotice([])).toBeNull()
  })

  it('names the ceiling that dropped configuration and warns the import is incomplete', () => {
    const notice = getSshConfigImportTruncationNotice(['expanded-output'])

    expect(notice).toContain('too large')
    expect(notice).toContain('incomplete')
  })

  it('lists every ceiling when more than one dropped configuration', () => {
    const notice = getSshConfigImportTruncationNotice(['file-count', 'nesting-depth'])

    expect(notice).toContain('too many files')
    expect(notice).toContain('nest too deeply')
  })

  it('reports nothing for an unrecognized reason rather than an empty warning', () => {
    // Why: main and renderer version independently, so a newer main can send a reason this
    // renderer has no copy for. A blank "Some hosts were skipped because ." is worse than silence.
    expect(getSshConfigImportTruncationNotice(['not-a-real-reason' as 'file-count'])).toBeNull()
  })
})

describe('getSshConfigImportOutcome', () => {
  it('reports success when hosts synced and nothing was dropped', () => {
    expect(getSshConfigImportOutcome({ targets: [{}, {}], truncatedBy: null })).toEqual({
      kind: 'synced'
    })
  })

  it('reports already-in-sync when nothing changed and nothing was dropped', () => {
    expect(getSshConfigImportOutcome({ targets: [], truncatedBy: null })).toEqual({
      kind: 'in-sync'
    })
  })

  // Why: this is the regression. A truncated import that happens to sync some hosts would
  // otherwise raise a plain success toast, telling the user everything landed when it did not.
  it('warns about truncation even when hosts synced successfully', () => {
    const outcome = getSshConfigImportOutcome({
      targets: [{}, {}],
      truncatedBy: ['expanded-output']
    })

    expect(outcome.kind).toBe('truncated')
  })

  // Why: the ceiling can drop every host past it while the ones before it are unchanged, so
  // "already in sync" is exactly as misleading as "synced" here.
  it('warns about truncation instead of claiming the config is already in sync', () => {
    const outcome = getSshConfigImportOutcome({ targets: [], truncatedBy: ['file-count'] })

    expect(outcome.kind).toBe('truncated')
  })
})
