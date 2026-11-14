import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  focusPairedClientWindow,
  revealPairedClientWindow,
  type RevealablePairedClient
} from './paired-client-window-reveal'

describe('paired client background safety', () => {
  afterEach(() => vi.unstubAllEnvs())

  function makeClient() {
    const showInactive = vi.fn()
    const focus = vi.fn()
    const getAllWindows = vi.fn(() => [{ isVisible: () => false, showInactive, focus }])
    const evaluate = vi.fn(async (callback) =>
      callback({
        app: { focus },
        BrowserWindow: { getAllWindows }
      })
    )
    const client = {
      app: { evaluate },
      page: { waitForFunction: vi.fn() }
    } as unknown as RevealablePairedClient
    return { client, showInactive, focus, getAllWindows }
  }

  it('rejects an explicit reveal before touching native windows', async () => {
    vi.stubEnv('ORCA_BACKGROUND_LAUNCH', '1')
    const { client, getAllWindows, showInactive } = makeClient()
    await expect(revealPairedClientWindow(client)).rejects.toThrow('Window reveal is forbidden')
    expect(getAllWindows).not.toHaveBeenCalled()
    expect(showInactive).not.toHaveBeenCalled()
  })

  it.each(['0', '1'])('rejects focus in background mode with foreground=%s', async (foreground) => {
    vi.stubEnv('ORCA_BACKGROUND_LAUNCH', '1')
    vi.stubEnv('ORCA_E2E_FOREGROUND', foreground)
    const { client, focus, getAllWindows } = makeClient()
    await expect(focusPairedClientWindow(client)).rejects.toThrow('Native focus is forbidden')
    expect(getAllWindows).not.toHaveBeenCalled()
    expect(focus).not.toHaveBeenCalled()
  })
})
