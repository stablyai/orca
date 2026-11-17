import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaCloudConsoleOpenResult } from '../../../../shared/orca-cloud-console'

const toast = vi.hoisted(() => ({ error: vi.fn(), warning: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

import { openCloudConsole } from './open-cloud-console'

function answer(result: OrcaCloudConsoleOpenResult): void {
  vi.stubGlobal('window', {
    api: { orcaProfiles: { openCloudConsole: vi.fn(async () => result) } }
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  toast.error.mockReset()
  toast.warning.mockReset()
})

describe('openCloudConsole', () => {
  it.each(['rejected', 'failed'] as const)(
    'says the console sign-in failed when a signed-in ticket was %s',
    async (ticketError) => {
      answer({ status: 'opened', signedIn: false, ticketError })
      await openCloudConsole('team')
      expect(toast.warning).toHaveBeenCalledTimes(1)
      expect(toast.error).not.toHaveBeenCalled()
    }
  )

  it('stays quiet when the page opened signed in, or nobody was signed in to begin with', async () => {
    answer({ status: 'opened', signedIn: true })
    await openCloudConsole('team')
    answer({ status: 'opened', signedIn: false })
    await openCloudConsole('billing')
    expect(toast.warning).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })
})
