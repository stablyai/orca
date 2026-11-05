import { describe, expect, it } from 'vitest'
import { parseShelvedDiffPath, toShelvedDiffPath } from './perforce-shelved-paths'

describe('shelved diff paths', () => {
  it('round-trips diff and view-only targets', () => {
    expect(parseShelvedDiffPath(toShelvedDiffPath('src/main.py', 3, false))).toEqual({
      path: 'src/main.py',
      changelist: 3,
      viewOnly: false
    })
    expect(parseShelvedDiffPath(toShelvedDiffPath('src/main.py', 12, true))).toEqual({
      path: 'src/main.py',
      changelist: 12,
      viewOnly: true
    })
  })

  it('ignores ordinary paths', () => {
    expect(parseShelvedDiffPath('src/main.py')).toBeNull()
  })
})
