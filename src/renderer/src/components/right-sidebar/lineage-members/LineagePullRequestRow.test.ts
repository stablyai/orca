import { describe, expect, it } from 'vitest'
import type { LineageMember } from '../../../../../shared/lineage-discovery-types'
import { lineagePullRequestLabel } from './LineagePullRequestRow'

const base: LineageMember = { repoName: 'api', branch: '', matchedBy: 'manual', reasons: [] }

describe('lineagePullRequestLabel', () => {
  it('names a PR, then a branch, then a gone worktree by its folder name', () => {
    expect(lineagePullRequestLabel({ ...base, pr: { number: 4 } })).toBe('api#4')
    expect(lineagePullRequestLabel({ ...base, branch: 'feat/x' })).toBe('api (feat/x)')
    expect(lineagePullRequestLabel({ ...base, worktreePath: '/w/api-removed/' })).toBe(
      'api (api-removed)'
    )
    expect(lineagePullRequestLabel({ ...base, worktreePath: 'C:\\w\\api-old' })).toBe(
      'api (api-old)'
    )
    expect(lineagePullRequestLabel(base)).toBe('api')
  })
})
