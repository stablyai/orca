/**
 * The RECORD half of the recency rule, pinned on its own.
 *
 * Round five failed because two writers HONOURED `workspaceCleanupRowReadAt` and
 * only one RECORDED it, so honouring it was inert on the path that mattered. Two
 * of the recording writers cannot be pinned by behaviour: the settle and the cache
 * hydrate each stamp exactly the `scannedAt` they publish in the same `set`, and
 * the republish is already floored at `rescannedAt >= scan.scannedAt`, so for those
 * rows an absent stamp and a correct one produce the same verdict at every reader.
 * Deleting either write reddens nothing; stamping a FUTURE read from the settle
 * reddens three, which is how we know the value is read. So the write itself is
 * asserted here — the failure mode is a MISSING write, not a wrong value.
 */
import fs from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceCleanupScanResult } from '../../../../shared/workspace-cleanup'
import { getWorkspaceCleanupCandidateIdentity } from '../../../../shared/workspace-cleanup-host-identity'
import {
  NOW,
  createCleanupTestStore,
  installWorkspaceCleanupApi,
  makeCandidate
} from './workspace-cleanup-slice-test-harness'

const EARLIER = NOW - 60_000
const CACHED_AT = NOW - 60 * 60 * 1000

const ALPHA = makeCandidate({
  worktreeId: 'repo1::/tmp/alpha',
  displayName: 'alpha',
  path: '/tmp/alpha'
})
const BETA = makeCandidate({
  worktreeId: 'repo1::/tmp/beta',
  displayName: 'beta',
  path: '/tmp/beta'
})

const alpha = getWorkspaceCleanupCandidateIdentity(ALPHA)
const beta = getWorkspaceCleanupCandidateIdentity(BETA)

function scanReturning(...results: WorkspaceCleanupScanResult[]): ReturnType<typeof vi.fn> {
  let call = 0
  return vi.fn(async () => results[Math.min(call++, results.length - 1)])
}

describe('workspace cleanup row reads are recorded by every writer that takes one', () => {
  it('records a read for every row a settling broad scan publishes', async () => {
    installWorkspaceCleanupApi(
      scanReturning({ scannedAt: NOW, candidates: [ALPHA, BETA], errors: [] })
    )
    const store = createCleanupTestStore()

    await store.getState().scanWorkspaceCleanup()

    expect(store.getState().workspaceCleanupRowReadAt).toEqual({ [alpha]: NOW, [beta]: NOW })
    // The equality the `rescannedAt >= scan.scannedAt` floor silently depends on:
    // a settle leaves no listed row dated older than the scan it sits in.
    expect(store.getState().workspaceCleanupScan?.scannedAt).toBe(NOW)
  })

  it('drops the read of a row a later settle no longer lists', async () => {
    installWorkspaceCleanupApi(
      scanReturning(
        { scannedAt: EARLIER, candidates: [ALPHA, BETA], errors: [] },
        { scannedAt: NOW, candidates: [ALPHA], errors: [] }
      )
    )
    const store = createCleanupTestStore()

    await store.getState().scanWorkspaceCleanup()
    expect(store.getState().workspaceCleanupRowReadAt).toEqual({
      [alpha]: EARLIER,
      [beta]: EARLIER
    })
    await store.getState().scanWorkspaceCleanup()

    // Not merely re-dated: a read kept for an unlisted row is one a row that
    // later reclaims the identity would inherit as its own.
    expect(store.getState().workspaceCleanupRowReadAt).toEqual({ [alpha]: NOW })
  })

  it('records a read for every row the cache seeds', async () => {
    installWorkspaceCleanupApi(
      vi.fn(),
      vi.fn().mockResolvedValue({
        scannedAt: CACHED_AT,
        candidates: [ALPHA, BETA],
        errors: []
      } satisfies WorkspaceCleanupScanResult)
    )
    const store = createCleanupTestStore()

    await expect(store.getState().hydrateWorkspaceCleanupFromCache()).resolves.toBe(true)

    expect(store.getState().workspaceCleanupRowReadAt).toEqual({
      [alpha]: CACHED_AT,
      [beta]: CACHED_AT
    })
  })

  it('drops the read of every row a completed removal took off the list', async () => {
    installWorkspaceCleanupApi(
      scanReturning({ scannedAt: NOW, candidates: [ALPHA, BETA], errors: [] })
    )
    const store = createCleanupTestStore(vi.fn().mockResolvedValue({ ok: true }))
    await store.getState().scanWorkspaceCleanup()

    await store.getState().removeWorkspaceCleanupCandidates([ALPHA.worktreeId])

    expect(store.getState().workspaceCleanupScan?.candidates.map((row) => row.worktreeId)).toEqual([
      BETA.worktreeId
    ])
    expect(store.getState().workspaceCleanupRowReadAt).toEqual({ [beta]: NOW })
  })
})

/**
 * Every module that writes `workspaceCleanupScan`, with what each owes the read
 * map. This is a ratchet, not documentation: a writer nobody counted is how round
 * five's split happened, so adding one has to land here, where the author has to
 * say whether it took a READ (stamp it) or only re-rendered rows already read
 * (leave the stamps alone).
 */
const SCAN_WRITERS = [
  {
    // slice type + initial state + the cache hydrate (a read) + dismiss and
    // reset-dismissals, which re-render rows already read and take no new one.
    file: 'workspace-cleanup.ts',
    scanWrites: 5,
    rowReadWrites: 3
  },
  { file: 'workspace-cleanup-scan-lifecycle.ts', scanWrites: 1, rowReadWrites: 1 },
  { file: 'workspace-cleanup-scan-progress.ts', scanWrites: 1, rowReadWrites: 1 },
  // The republish, and the completion that prunes the reads of removed rows.
  { file: 'workspace-cleanup-removal.ts', scanWrites: 2, rowReadWrites: 2 }
] as const

describe('the set of writers that replace cleanup rows is closed', () => {
  const sliceDirectory = new URL('.', import.meta.url)
  const sources = fs
    .readdirSync(sliceDirectory)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => ({ name, source: fs.readFileSync(new URL(name, sliceDirectory), 'utf8') }))

  const occurrences = (source: string, token: string): number => source.split(token).length - 1

  it('has no writer outside the declared set', () => {
    expect(
      sources
        .filter(({ source }) => source.includes('workspaceCleanupScan:'))
        .map(({ name }) => name)
        .sort()
    ).toEqual(SCAN_WRITERS.map((writer) => writer.file).sort())
  })

  it.each(SCAN_WRITERS)(
    '$file writes the scan $scanWrites times and the read map $rowReadWrites times',
    ({ file, scanWrites, rowReadWrites }) => {
      const source = sources.find(({ name }) => name === file)?.source ?? ''
      expect(occurrences(source, 'workspaceCleanupScan:')).toBe(scanWrites)
      expect(occurrences(source, 'workspaceCleanupRowReadAt:')).toBe(rowReadWrites)
    }
  )
})
