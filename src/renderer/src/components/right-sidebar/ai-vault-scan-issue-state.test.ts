import { describe, expect, it } from 'vitest'
import type { AiVaultListResult } from '../../../../shared/ai-vault-types'
import {
  aiVaultScanNoticeIssues,
  aiVaultSessionFileKey,
  aiVaultSessionReadNotices,
  blockingAiVaultScanIssue,
  skippedAiVaultTranscriptCount,
  skippedAiVaultTranscriptReasons
} from './ai-vault-scan-issue-state'

// The panel builds the notice map once and hands the same one to the banners.
function noticeIssues(scan: AiVaultListResult | null) {
  return aiVaultScanNoticeIssues(scan, aiVaultSessionReadNotices(scan))
}

describe('blockingAiVaultScanIssue', () => {
  it('surfaces the cause when a scan returns no sessions', () => {
    const issue = {
      executionHostId: 'ssh:dev-box' as const,
      agent: 'codex' as const,
      kind: 'host' as const,
      path: 'dev-box',
      message: 'Remote connection dropped. Reconnect the SSH target.'
    }

    expect(blockingAiVaultScanIssue(result([], [issue]))).toEqual(issue)
  })

  it('leaves partial-result issues as a skipped transcript count', () => {
    expect(
      blockingAiVaultScanIssue(
        result(
          [{ id: 'session' }],
          [{ agent: 'codex', path: '/bad.jsonl', message: 'Malformed transcript' }]
        )
      )
    ).toBeNull()
  })

  it('does not block an empty scan for a skipped transcript', () => {
    expect(
      blockingAiVaultScanIssue(
        result([], [{ agent: 'codex', path: '/bad.jsonl', message: 'Malformed transcript' }])
      )
    ).toBeNull()
  })
})

describe('aiVaultScanNoticeIssues', () => {
  it('surfaces scope truncation without counting it as a skipped transcript', () => {
    const scopeIssue = {
      agent: 'codex' as const,
      kind: 'scope' as const,
      path: '/home/ada',
      message: 'Only the first 64 project paths were scanned.'
    }
    const truncated = result([], [scopeIssue])

    expect(blockingAiVaultScanIssue(truncated)).toBeNull()
    expect(noticeIssues(truncated)).toEqual([scopeIssue])
    expect(skippedAiVaultTranscriptCount(truncated)).toBe(0)
  })

  it('keeps kinded issues as notices and counts only transcripts as skipped', () => {
    const hostIssue = {
      executionHostId: 'ssh:dev-box' as const,
      agent: 'codex' as const,
      kind: 'host' as const,
      path: 'dev-box',
      message: 'Remote connection dropped.'
    }
    const scopeIssue = {
      agent: 'codex' as const,
      kind: 'scope' as const,
      path: '/home/ada',
      message: 'Only the first 64 project paths were scanned.'
    }
    const partial = result(
      [{ id: 'session' }],
      [hostIssue, scopeIssue, { agent: 'codex', path: '/bad.jsonl', message: 'Malformed' }]
    )

    expect(noticeIssues(partial)).toEqual([hostIssue, scopeIssue])
    expect(skippedAiVaultTranscriptCount(partial)).toBe(1)
  })

  // #15036: a locked opencode.db holds every OpenCode session, so reporting it
  // as "1 transcript skipped" both understates the loss and buries the cause in
  // a bare driver string.
  it('gives an unreadable OpenCode database its own row instead of a skipped count', () => {
    const sourceIssue = {
      agent: 'opencode' as const,
      kind: 'scope' as const,
      path: '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.local\\share\\opencode\\opencode.db',
      message:
        'OpenCode is writing to opencode.db right now, so its history was skipped. It is read again on the next refresh.'
    }
    const empty = result([], [sourceIssue])

    expect(skippedAiVaultTranscriptCount(empty)).toBe(0)
    expect(skippedAiVaultTranscriptReasons(empty)).toEqual([])
    expect(noticeIssues(empty)).toEqual([sourceIssue])
  })

  it('does not repeat the blocking issue as a notice row', () => {
    const hostIssue = {
      executionHostId: 'ssh:dev-box' as const,
      agent: 'codex' as const,
      kind: 'host' as const,
      path: 'dev-box',
      message: 'Remote connection dropped.'
    }

    expect(noticeIssues(result([], [hostIssue]))).toEqual([])
  })

  it('reports nothing before the first scan', () => {
    expect(noticeIssues(null)).toEqual([])
    expect(skippedAiVaultTranscriptCount(null)).toBe(0)
  })
})

describe('aiVaultSessionReadNotices', () => {
  const oversized = {
    executionHostId: 'local' as const,
    agent: 'pi' as const,
    kind: 'notice' as const,
    path: '/sessions/big.jsonl',
    message: 'Skipped 1 oversized transcript record over the 10.0 MiB limit.'
  }

  it('moves a notice about a listed session onto that session instead of a banner', () => {
    const scan = result([{ id: 'big' }], [oversized])

    expect(noticeIssues(scan)).toEqual([])
    expect(aiVaultSessionReadNotices(scan).get(aiVaultSessionFileKey(scan.sessions[0]))).toEqual([
      oversized.message
    ])
  })

  it('keeps a notice that matches no listed session as a banner', () => {
    const overflow = { ...oversized, path: '/sessions' }
    const scan = result([{ id: 'big' }], [overflow])

    expect(noticeIssues(scan)).toEqual([overflow])
    expect(aiVaultSessionReadNotices(scan).size).toBe(0)
  })

  it('does not attach a notice from another host to a same-path session', () => {
    const scan = result([{ id: 'big' }], [{ ...oversized, executionHostId: 'ssh:dev-box' }])

    expect(aiVaultSessionReadNotices(scan).size).toBe(0)
  })
})

describe('skippedAiVaultTranscriptReasons', () => {
  it('surfaces the file-too-large reason behind a skipped transcript', () => {
    expect(
      skippedAiVaultTranscriptReasons(
        result(
          [{ id: 'session' }],
          [
            {
              agent: 'claude',
              path: '/home/dev/.claude/projects/a/huge.jsonl',
              message: 'File too large: 12.4MB exceeds 10MB limit'
            }
          ]
        )
      )
    ).toEqual(['File too large: 12.4MB exceeds 10MB limit'])
  })

  it('leaves host and scope notices to their own rows', () => {
    expect(
      skippedAiVaultTranscriptReasons(
        result(
          [],
          [
            {
              agent: 'codex',
              kind: 'scope',
              path: '/home/dev',
              message: 'Only the first 64 project paths were scanned.'
            },
            { agent: 'codex', kind: 'host', path: 'dev-box', message: 'Reconnect the SSH target.' }
          ]
        )
      )
    ).toEqual([])
  })

  it('dedupes repeats and caps the list so a 500-issue scan stays readable', () => {
    const issues = Array.from({ length: 40 }, (_unused, index) => ({
      agent: 'codex' as const,
      path: `/transcripts/${index}.jsonl`,
      message: `Unreadable transcript ${index % 5}`
    }))

    expect(skippedAiVaultTranscriptReasons(result([], issues))).toEqual([
      'Unreadable transcript 0',
      'Unreadable transcript 1',
      'Unreadable transcript 2'
    ])
  })

  it('reports nothing before the first scan', () => {
    expect(skippedAiVaultTranscriptReasons(null)).toEqual([])
  })
})

function result(
  sessions: { id: string; filePath?: string; executionHostId?: string }[],
  issues: AiVaultListResult['issues']
): AiVaultListResult {
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixtures carry only the fields these helpers read.
    sessions: sessions.map((session) => ({
      executionHostId: 'local',
      filePath: `/sessions/${session.id}.jsonl`,
      ...session
    })) as unknown as AiVaultListResult['sessions'],
    issues,
    scannedAt: '2026-07-26T00:00:00.000Z'
  }
}
