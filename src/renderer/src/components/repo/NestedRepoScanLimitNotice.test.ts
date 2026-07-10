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

  it('includes explicit timeout stops only when callers configure one', () => {
    const scan: NestedRepoScanResult = {
      selectedPath: '/workspace/platform',
      selectedPathKind: 'non_git_folder',
      repos: [],
      truncated: false,
      timedOut: true,
      stopped: false,
      durationMs: 8_000,
      maxDepth: 3,
      maxRepos: 100,
      timeoutMs: 8_000
    }

    expect(nestedRepoScanLimitText(scan)).toBe(
      'Scan stops after 3 folder levels or 100 repositories or 8 seconds. You can stop scanning early and import repositories found so far.'
    )
  })
})
