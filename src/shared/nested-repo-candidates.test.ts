import { describe, expect, it } from 'vitest'
import { hasImportableNestedRepo, isImportableNestedRepoCandidate } from './nested-repo-candidates'
import type { NestedRepoCandidate } from './project-group-types'

function candidate(
  path: string,
  overrides: Partial<NestedRepoCandidate> = {}
): NestedRepoCandidate {
  return { path, displayName: path.split('/').at(-1) ?? path, depth: 1, ...overrides }
}

describe('isImportableNestedRepoCandidate', () => {
  it('treats a plain nested clone as importable', () => {
    expect(isImportableNestedRepoCandidate(candidate('/parent/api'))).toBe(true)
  })

  it('treats a submodule as opt-in, not importable', () => {
    expect(
      isImportableNestedRepoCandidate(candidate('/parent/design', { isSubmodule: true }))
    ).toBe(false)
  })
})

describe('hasImportableNestedRepo', () => {
  it('is false for a repo whose only nested repos are its own submodules', () => {
    // Why this case matters: such a repo is a plain repo and must keep adding
    // directly instead of being diverted into a review with nothing to review.
    expect(
      hasImportableNestedRepo([candidate('/parent/design', { isSubmodule: true })], '/parent')
    ).toBe(false)
  })

  it('is true once a real nested clone turns up', () => {
    expect(
      hasImportableNestedRepo(
        [candidate('/parent/design', { isSubmodule: true }), candidate('/parent/api')],
        '/parent'
      )
    ).toBe(true)
  })

  it('does not count the selected folder as its own discovery', () => {
    expect(hasImportableNestedRepo([candidate('/parent', { depth: 0 })], '/parent')).toBe(false)
  })

  it('is false for an empty scan', () => {
    expect(hasImportableNestedRepo([], '/parent')).toBe(false)
  })
})
