import { expect, it } from 'vitest'
import { createRateLimitsApi } from './web-rate-limits-api'

it("never hands the server's own usage back as a WSL distro's (#42644)", async () => {
  const read = await createRateLimitsApi().readUsageForRuntimeTarget(
    { runtime: 'wsl', wslDistro: 'Ubuntu' },
    ['claude', 'codex']
  )
  expect(read).toBeNull()
})
