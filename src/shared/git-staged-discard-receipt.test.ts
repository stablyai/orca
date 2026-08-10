import { describe, expect, it, vi } from 'vitest'
import {
  GitStagedDiscardReceiptLedger,
  pendingGitStagedDiscardReceipt,
  runGitStagedDiscardBatches
} from './git-staged-discard-receipt'

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
})
