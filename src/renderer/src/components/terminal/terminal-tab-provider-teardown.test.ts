import { expect, it, vi } from 'vitest'
import {
  getTerminalTabProviderTeardown,
  trackTerminalTabProviderTeardown
} from './terminal-tab-provider-teardown'

it('fails closed after retry authority eviction and re-runs the newest teardown', async () => {
  const retries = Array.from({ length: 129 }, () => vi.fn().mockResolvedValue(undefined))
  for (const [index, retry] of retries.entries()) {
    trackTerminalTabProviderTeardown(
      [`failed-tab-${index}`],
      Promise.reject(new Error('provider unavailable')),
      retry
    )
  }
  await Promise.resolve()

  await expect(getTerminalTabProviderTeardown('failed-tab-0')).rejects.toThrow(
    'terminal_tab_close_failed'
  )
  expect(getTerminalTabProviderTeardown('never-tracked-tab')).toBeUndefined()
  await expect(getTerminalTabProviderTeardown('failed-tab-128')).resolves.toBeUndefined()
  expect(retries[128]).toHaveBeenCalledOnce()
})

it('keeps fail-closed markers beyond the former 512-id residual cap', async () => {
  for (let index = 0; index < 641; index += 1) {
    trackTerminalTabProviderTeardown(
      [`overflow-tab-${index}`],
      Promise.reject(new Error('provider unavailable')),
      vi.fn().mockResolvedValue(undefined)
    )
  }
  await Promise.resolve()

  await expect(getTerminalTabProviderTeardown('overflow-tab-0')).rejects.toThrow(
    'terminal_tab_close_failed'
  )
  await expect(getTerminalTabProviderTeardown('unknown-after-overflow')).rejects.toThrow(
    'terminal_tab_close_failed'
  )
})
