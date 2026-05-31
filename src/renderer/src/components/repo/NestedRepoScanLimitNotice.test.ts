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
      durationMs: 100,
      maxDepth: 3,
      maxRepos: 100,
      timeoutMs: 8_000
    }

    expect(nestedRepoScanLimitText(scan)).toBe(
      'Scan stops after 3 folder levels, 100 repositories, or 8 seconds.'
    )
  })
})
