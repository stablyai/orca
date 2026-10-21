import { describe, expect, it } from 'vitest'
import { normalizeOrcadRetainedMarker, withoutOrcadRetainedMarker } from './orcad-retained-marker'

describe('normalizeOrcadRetainedMarker', () => {
  it('keeps a well-formed mark, with or without its change time', () => {
    const mark = { migrationId: 'move-1', environmentId: 'wsl:Ubuntu' }
    expect(normalizeOrcadRetainedMarker(mark)).toEqual(mark)
    expect(
      normalizeOrcadRetainedMarker({ ...mark, sourceChangedAt: '2026-10-20T00:00:00.000Z' })
    ).toEqual({ ...mark, sourceChangedAt: '2026-10-20T00:00:00.000Z' })
  })

  it.each([null, 'move-1', { migrationId: 'move-1' }, { migrationId: '', environmentId: 'e' }])(
    'reads %j as no mark',
    (value) => {
      expect(normalizeOrcadRetainedMarker(value)).toBeUndefined()
    }
  )
})

describe('withoutOrcadRetainedMarker', () => {
  it('copies the row without the mark and leaves the stored row as it was', () => {
    const row = { id: 'repo-a', orcadRetained: { migrationId: 'move-1', environmentId: 'wsl:U' } }
    expect(withoutOrcadRetainedMarker(row)).toEqual({ id: 'repo-a' })
    expect(row.orcadRetained).toEqual({ migrationId: 'move-1', environmentId: 'wsl:U' })
  })
})
