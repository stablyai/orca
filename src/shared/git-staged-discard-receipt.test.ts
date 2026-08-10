import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertGitStagedDiscardReceipt,
  awaitTerminalGitStagedDiscardReceipt,
  createGitStagedDiscardOperationId,
  pendingGitStagedDiscardReceipt,
  runGitStagedDiscardBatches
} from './git-staged-discard-receipt'
import { GitStagedDiscardReceiptFileStorage } from './git-staged-discard-receipt-file-storage'
import { GitStagedDiscardReceiptLedger } from './git-staged-discard-receipt-ledger'

const cleanupPaths: string[] = []

afterEach(() => {
  for (const cleanupPath of cleanupPaths.splice(0)) {
    rmSync(cleanupPath, { recursive: true, force: true })
  }
})

describe('staged discard mutation receipts', () => {
  it('reports the uncertain batch and untouched tail after a partial failure', async () => {
    const run = vi.fn(async (paths: readonly string[]) => {
      if (paths.includes('c')) {
        throw new Error('permission denied')
      }
    })

    const receipt = await runGitStagedDiscardBatches('op-1', ['a', 'b', 'c', 'd', 'e'], 2, run)

    expect(receipt).toMatchObject({
      state: 'failed',
      mutation: 'partial',
      completedPaths: ['a', 'b'],
      uncertainPaths: ['c', 'd'],
      remainingPaths: ['e'],
      error: 'permission denied'
    })
  })

  it('returns the in-flight and settled receipt after a lost acknowledgement', async () => {
    const ledger = new GitStagedDiscardReceiptLedger()
    let finish!: () => void
    const blocked = new Promise<void>((resolve) => {
      finish = resolve
    })
    const pending = pendingGitStagedDiscardReceipt('op-1', ['a'])
    const first = ledger.run('repo', 'op-1', 'a', pending, async () => {
      await blocked
      return runGitStagedDiscardBatches('op-1', ['a'], 100, async () => {})
    })

    expect(ledger.get('repo', 'op-1')).toEqual(pending)
    expect(ledger.run('repo', 'op-1', 'a', pending, async () => pending)).toBe(first)
    finish()
    await expect(first).resolves.toMatchObject({ state: 'succeeded', mutation: 'complete' })
    expect(ledger.get('repo', 'op-1')).toMatchObject({ state: 'succeeded' })
  })

  it('rejects mutation ID reuse for different pathsets', async () => {
    const ledger = new GitStagedDiscardReceiptLedger()
    const pending = pendingGitStagedDiscardReceipt('op-1', ['a'])
    await ledger.run('repo', 'op-1', 'a', pending, async () => pending)

    await expect(ledger.run('repo', 'op-1', 'b', pending, async () => pending)).rejects.toThrow(
      'reused'
    )
  })

  it('waits through delayed pending receipts until authoritative settlement', async () => {
    const pending = pendingGitStagedDiscardReceipt('op-1', ['a'])
    const getReceipt = vi
      .fn()
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce({
        operationId: 'op-1',
        state: 'succeeded',
        mutation: 'complete',
        affectedPaths: ['a'],
        completedPaths: ['a'],
        uncertainPaths: [],
        remainingPaths: []
      })

    await expect(
      awaitTerminalGitStagedDiscardReceipt(pending, 'op-1', ['a'], getReceipt, async () => {})
    ).resolves.toMatchObject({ state: 'succeeded' })
    expect(getReceipt).toHaveBeenCalledTimes(2)
  })

  it('terminates polling when an intermediate receipt is contradictory', async () => {
    const pending = pendingGitStagedDiscardReceipt('op-1', ['a'])
    const getReceipt = vi
      .fn()
      .mockResolvedValueOnce({
        ...pending,
        completedPaths: ['a']
      })
      .mockResolvedValueOnce({
        operationId: 'op-1',
        state: 'succeeded',
        mutation: 'complete',
        affectedPaths: ['a'],
        completedPaths: ['a'],
        uncertainPaths: [],
        remainingPaths: []
      })

    await expect(
      awaitTerminalGitStagedDiscardReceipt(pending, 'op-1', ['a'], getReceipt, async () => {})
    ).rejects.toThrow('invalid')
    expect(getReceipt).toHaveBeenCalledTimes(1)
  })

  it('cancels polling without retaining a waiter or reading another receipt', async () => {
    const pending = pendingGitStagedDiscardReceipt('op-1', ['a'])
    const controller = new AbortController()
    let releaseWait!: () => void
    const wait = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseWait = resolve
        })
    )
    const getReceipt = vi.fn()
    const result = awaitTerminalGitStagedDiscardReceipt(
      pending,
      'op-1',
      ['a'],
      getReceipt,
      wait,
      controller.signal
    )

    controller.abort()
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    releaseWait()
    await Promise.resolve()
    expect(wait).toHaveBeenCalledTimes(1)
    expect(getReceipt).not.toHaveBeenCalled()
  })

  it.each([
    {
      operationId: 'wrong',
      state: 'succeeded',
      mutation: 'complete',
      affectedPaths: ['a'],
      completedPaths: ['a'],
      uncertainPaths: [],
      remainingPaths: []
    },
    {
      operationId: 'op-1',
      state: 'succeeded',
      mutation: 'complete',
      affectedPaths: ['a', 'extra'],
      completedPaths: ['a', 'extra'],
      uncertainPaths: [],
      remainingPaths: []
    },
    {
      operationId: 'op-1',
      state: 'failed',
      mutation: 'partial',
      affectedPaths: ['a', 'b'],
      completedPaths: ['a'],
      uncertainPaths: ['a'],
      remainingPaths: []
    },
    {
      operationId: 'op-1',
      state: 'pending',
      mutation: 'possible',
      affectedPaths: ['a', 'b'],
      completedPaths: [],
      uncertainPaths: ['a'],
      remainingPaths: []
    }
  ])('rejects contradictory or unbound receipt %#', (receipt) => {
    expect(() => assertGitStagedDiscardReceipt(receipt, 'op-1', ['a', 'b'])).toThrow('invalid')
  })

  it('persists pending identity before mutation and fails it closed after restart', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'orca-staged-discard-ledger-'))
    cleanupPaths.push(root)
    const storage = new GitStagedDiscardReceiptFileStorage(path.join(root, 'receipts.json'))
    const operationId = createGitStagedDiscardOperationId(1_000)
    let finish!: () => void
    const blocked = new Promise<void>((resolve) => {
      finish = resolve
    })
    const firstLedger = new GitStagedDiscardReceiptLedger({ storage, now: () => 1_000 })
    const first = firstLedger.run(
      'repo',
      operationId,
      'a',
      pendingGitStagedDiscardReceipt(operationId, ['a']),
      async () => {
        await blocked
        return runGitStagedDiscardBatches(operationId, ['a'], 100, async () => {})
      }
    )

    const restarted = new GitStagedDiscardReceiptLedger({ storage, now: () => 1_001 })
    expect(restarted.get('repo', operationId)).toMatchObject({
      state: 'failed',
      mutation: 'possible',
      uncertainPaths: ['a']
    })
    const duplicateMutation = vi.fn()
    await expect(
      restarted.run(
        'repo',
        operationId,
        'a',
        pendingGitStagedDiscardReceipt(operationId, ['a']),
        duplicateMutation
      )
    ).resolves.toMatchObject({ state: 'failed', mutation: 'possible' })
    expect(duplicateMutation).not.toHaveBeenCalled()
    finish()
    await first
  })

  it('replays an externally propagated terminal settlement', async () => {
    const ledger = new GitStagedDiscardReceiptLedger()
    const operationId = createGitStagedDiscardOperationId(1_000)
    const pending = pendingGitStagedDiscardReceipt(operationId, ['a'])
    await ledger.run('repo', operationId, 'a', pending, async () => pending)
    const succeeded = await runGitStagedDiscardBatches(operationId, ['a'], 100, async () => {})

    ledger.reconcileAuthoritative('repo', operationId, succeeded)

    const duplicateMutation = vi.fn()
    await expect(ledger.run('repo', operationId, 'a', pending, duplicateMutation)).resolves.toEqual(
      succeeded
    )
    expect(duplicateMutation).not.toHaveBeenCalled()
  })

  it('removes an entry when its initial durable write fails', async () => {
    let shouldFail = true
    const storage = {
      load: () => null,
      save: vi.fn(() => {
        if (shouldFail) {
          throw new Error('disk full')
        }
      })
    }
    const ledger = new GitStagedDiscardReceiptLedger({ storage })
    const operationId = createGitStagedDiscardOperationId(1_000)
    const pending = pendingGitStagedDiscardReceipt(operationId, ['a'])
    const mutation = vi.fn(async () => pending)

    await expect(ledger.run('repo', operationId, 'a', pending, mutation)).rejects.toThrow(
      'disk full'
    )
    shouldFail = false
    await expect(ledger.run('repo', operationId, 'a', pending, mutation)).resolves.toEqual(pending)
    expect(mutation).toHaveBeenCalledTimes(1)
  })

  it('expires replay identities without permitting delayed duplicate execution', async () => {
    let now = 1_000
    const ledger = new GitStagedDiscardReceiptLedger({
      maxReceipts: 1,
      retentionMs: 100,
      now: () => now
    })
    const legacyMutation = vi.fn(async () =>
      runGitStagedDiscardBatches('legacy-op', ['a'], 100, async () => {})
    )
    await ledger.run(
      'repo',
      'legacy-op',
      'a',
      pendingGitStagedDiscardReceipt('legacy-op', ['a']),
      legacyMutation
    )
    now = 1_101
    const currentId = createGitStagedDiscardOperationId(now)
    await ledger.run(
      'repo',
      currentId,
      'b',
      pendingGitStagedDiscardReceipt(currentId, ['b']),
      async () => runGitStagedDiscardBatches(currentId, ['b'], 100, async () => {})
    )

    await expect(
      ledger.run(
        'repo',
        'legacy-op',
        'a',
        pendingGitStagedDiscardReceipt('legacy-op', ['a']),
        legacyMutation
      )
    ).rejects.toThrow('predates')
    expect(legacyMutation).toHaveBeenCalledTimes(1)

    now = 1_202
    const newerId = createGitStagedDiscardOperationId(now)
    await ledger.run(
      'repo',
      newerId,
      'c',
      pendingGitStagedDiscardReceipt(newerId, ['c']),
      async () => runGitStagedDiscardBatches(newerId, ['c'], 100, async () => {})
    )
    const delayedMutation = vi.fn()
    await expect(
      ledger.run(
        'repo',
        currentId,
        'b',
        pendingGitStagedDiscardReceipt(currentId, ['b']),
        delayedMutation
      )
    ).rejects.toThrow('outside the replay window')
    expect(delayedMutation).not.toHaveBeenCalled()
  })

  it('refuses capacity pressure instead of evicting live replay identities', async () => {
    const now = 1_000
    const ledger = new GitStagedDiscardReceiptLedger({ maxReceipts: 1, now: () => now })
    const firstId = createGitStagedDiscardOperationId(now)
    let finish!: () => void
    const blocked = new Promise<void>((resolve) => {
      finish = resolve
    })
    const first = ledger.run(
      'repo',
      firstId,
      'a',
      pendingGitStagedDiscardReceipt(firstId, ['a']),
      async () => {
        await blocked
        return runGitStagedDiscardBatches(firstId, ['a'], 100, async () => {})
      }
    )
    const secondId = createGitStagedDiscardOperationId(now)
    const secondMutation = vi.fn()
    await expect(
      ledger.run(
        'repo',
        secondId,
        'b',
        pendingGitStagedDiscardReceipt(secondId, ['b']),
        secondMutation
      )
    ).rejects.toThrow('retained')
    expect(secondMutation).not.toHaveBeenCalled()
    finish()
    await first
  })

  it('does not compare client operation timestamps to an SSH host clock', async () => {
    const ledger = new GitStagedDiscardReceiptLedger({ now: () => 1_000 })
    const farFutureClientId = createGitStagedDiscardOperationId(9_000_000_000)
    await expect(
      ledger.run(
        'repo',
        farFutureClientId,
        'a',
        pendingGitStagedDiscardReceipt(farFutureClientId, ['a']),
        async () => runGitStagedDiscardBatches(farFutureClientId, ['a'], 100, async () => {})
      )
    ).resolves.toMatchObject({ state: 'succeeded' })
  })

  it('does not let an evicted far-future client clock poison normal host operations', async () => {
    let now = 1_000
    const ledger = new GitStagedDiscardReceiptLedger({
      maxReceipts: 1,
      retentionMs: 10,
      now: () => now
    })
    const futureId = createGitStagedDiscardOperationId(9_000_000_000)
    await ledger.run(
      'repo',
      futureId,
      'a',
      pendingGitStagedDiscardReceipt(futureId, ['a']),
      async () => runGitStagedDiscardBatches(futureId, ['a'], 100, async () => {})
    )
    now = 1_011
    const currentId = createGitStagedDiscardOperationId(now)
    await expect(
      ledger.run(
        'repo',
        currentId,
        'b',
        pendingGitStagedDiscardReceipt(currentId, ['b']),
        async () => runGitStagedDiscardBatches(currentId, ['b'], 100, async () => {})
      )
    ).resolves.toMatchObject({ state: 'succeeded' })
    await expect(
      ledger.run('repo', futureId, 'a', pendingGitStagedDiscardReceipt(futureId, ['a']), vi.fn())
    ).rejects.toThrow('outside the replay window')
  })

  it('bounds retained receipt bytes and journals incremental settlements', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'orca-staged-discard-bytes-'))
    cleanupPaths.push(root)
    const filePath = path.join(root, 'receipts.json')
    const storage = new GitStagedDiscardReceiptFileStorage(filePath)
    let now = 1_000
    const ledger = new GitStagedDiscardReceiptLedger({
      storage,
      maxReceipts: 64,
      maxBytes: 8_000,
      now: () => now
    })
    for (let index = 0; index < 20; index += 1) {
      const operationId = createGitStagedDiscardOperationId(now++)
      const paths = Array.from({ length: 10 }, (_, pathIndex) => `${index}-${pathIndex}.txt`)
      await ledger.run(
        'repo',
        operationId,
        paths.join('\0'),
        pendingGitStagedDiscardReceipt(operationId, paths),
        async () => runGitStagedDiscardBatches(operationId, paths, 100, async () => {})
      )
    }

    expect(readFileSync(filePath, 'utf8')).toContain('ORCA_GIT_STAGED_DISCARD_V1')
    expect(statSync(filePath).size).toBeLessThan(64_000)
    expect(
      new GitStagedDiscardReceiptLedger({ storage, maxReceipts: 64 }).get('repo', 'missing')
    ).toBeNull()
  })

  it('ignores only a crash-truncated final journal record', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'orca-staged-discard-crash-'))
    cleanupPaths.push(root)
    const filePath = path.join(root, 'receipts.json')
    const storage = new GitStagedDiscardReceiptFileStorage(filePath)
    const operationId = createGitStagedDiscardOperationId(1_000)
    const ledger = new GitStagedDiscardReceiptLedger({ storage, now: () => 1_000 })
    await ledger.run(
      'repo',
      operationId,
      'a',
      pendingGitStagedDiscardReceipt(operationId, ['a']),
      async () => runGitStagedDiscardBatches(operationId, ['a'], 100, async () => {})
    )
    appendFileSync(filePath, '\nORCA_GIT_STAGED_DISCARD_V1 {"upsert":')

    expect(
      new GitStagedDiscardReceiptLedger({ storage, now: () => 1_001 }).get('repo', operationId)
    ).toMatchObject({ state: 'succeeded' })
  })
})
