import { describe, expect, it, vi } from 'vitest'
import {
  createLinuxProcTextReadBudget,
  LINUX_PROC_NETWORK_TABLE_MAX_BYTES,
  readLinuxProcNetworkTable,
  readLinuxProcTextWithinBudget
} from './linux-proc-port-scan-limits'

describe('Linux proc port scan limits', () => {
  it('applies the network-table byte cap before retaining content', async () => {
    const readFile = vi.fn(async () => Buffer.from('table'))

    await expect(readLinuxProcNetworkTable('/proc/net/tcp', readFile)).resolves.toBe('table')
    expect(readFile).toHaveBeenCalledWith('/proc/net/tcp', LINUX_PROC_NETWORK_TABLE_MAX_BYTES)
  })

  it('shares one retained-byte budget across process metadata files', async () => {
    const budget = createLinuxProcTextReadBudget(5)
    const readFile = vi
      .fn<(filePath: string, maxBytes: number) => Promise<Buffer>>()
      .mockResolvedValueOnce(Buffer.from('abc'))
      .mockResolvedValueOnce(Buffer.from('de'))

    await expect(readLinuxProcTextWithinBudget('/proc/1/comm', budget, readFile, 4)).resolves.toBe(
      'abc'
    )
    await expect(
      readLinuxProcTextWithinBudget('/proc/1/cmdline', budget, readFile, 4)
    ).resolves.toBe('de')
    await expect(
      readLinuxProcTextWithinBudget('/proc/2/cmdline', budget, readFile, 4)
    ).resolves.toBeUndefined()

    expect(readFile.mock.calls).toEqual([
      ['/proc/1/comm', 4],
      ['/proc/1/cmdline', 2]
    ])
    expect(budget.remainingBytes).toBe(0)
  })

  it('does not debit failed metadata reads', async () => {
    const budget = createLinuxProcTextReadBudget(4)
    const readFile = vi.fn(async () => {
      throw new Error('oversized')
    })

    await expect(
      readLinuxProcTextWithinBudget('/proc/1/cmdline', budget, readFile)
    ).resolves.toBeUndefined()
    expect(budget.remainingBytes).toBe(4)
  })
})
