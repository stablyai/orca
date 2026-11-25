import { describe, expect, it } from 'vitest'
import { buildFolderStatusMap, buildStatusMap, getPathDecoration } from './git-path-decoration'
import type { GitFileStatus } from './git-status-types'

describe('git path decoration for decomposed names', () => {
  it('matches a decomposed (NFD) listed name to the composed (NFC) path Git reports', () => {
    const entries: { path: string; status: GitFileStatus }[] = [
      { path: '회의/회의록.md', status: 'modified' }
    ]
    expect(getPathDecoration(buildStatusMap(entries), '회의/회의록.md'.normalize('NFD'))).toBe(
      'modified'
    )
    expect(getPathDecoration(buildFolderStatusMap(entries), '회의'.normalize('NFD'))).toBe(
      'modified'
    )
  })

  it('prefers the listed key over its composed twin on byte-exact hosts', () => {
    const decomposed = 'café.txt'.normalize('NFD')
    const statuses = buildStatusMap([
      { path: 'café.txt', status: 'modified' },
      { path: decomposed, status: 'untracked' }
    ])
    expect(getPathDecoration(statuses, decomposed)).toBe('untracked')
  })
})
