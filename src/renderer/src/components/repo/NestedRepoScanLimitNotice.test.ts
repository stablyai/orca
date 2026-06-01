import { describe, expect, it } from 'vitest'
import type { NestedRepoScanResult } from '../../../../shared/types'
import { nestedRepoScanLimitText } from './NestedRepoScanLimitNotice'

describe('nestedRepoScanLimitText', () => {
  it('summarizes the bounded scan stops from the scan result', () => {
    const scan: NestedRepoScanResult = {
      selectedPath: '/workspace/platform',
      selectedPathKind: 'non_git_folder',
      repos: [],
      truncated: true,
      timedOut: false,
      stopped: false,
      durationMs: 100,
      maxDepth: 3,
      maxRepos: 100,
      timeoutMs: null
    }

    expect(nestedRepoScanLimitText(scan)).toBe(
      'Scan stops after 3 folder levels or 100 repositories. You can stop scanning early and import repositories found so far.'
    )
  })
})
