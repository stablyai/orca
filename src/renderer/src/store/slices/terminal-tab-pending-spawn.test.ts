import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  beginPendingTerminalTabSpawn,
  claimPendingTerminalTabSpawns,
  waitForPendingTerminalTabRetirement
} from './terminal-tab-pending-spawn'

describe('pending terminal tab spawn retirement', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('bounds close proof while retaining one late-spawn retirement', async () => {
    const registration = beginPendingTerminalTabSpawn('tab-pending')
    const retirePty = vi.fn(async () => {})
    const firstClaim = claimPendingTerminalTabSpawns('tab-pending')[0]!
    const retirement = firstClaim.retire(retirePty)
    const retryRetirement = claimPendingTerminalTabSpawns('tab-pending')[0]!.retire(
      vi.fn(async () => {})
    )
    const proof = waitForPendingTerminalTabRetirement(retirement, 25)
    const outcome = proof.then(
      () => 'resolved',
      (error: unknown) => (error instanceof Error ? error.message : String(error))
    )

    await vi.advanceTimersByTimeAsync(25)

    await expect(outcome).resolves.toBe('terminal_tab_close_failed')
    expect(retryRetirement).toBe(retirement)

    registration.settle('pty-late')
    await retirement
    expect(retirePty).toHaveBeenCalledOnce()
    expect(retirePty).toHaveBeenCalledWith('pty-late')
  })
})
