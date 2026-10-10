import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertPairedClientWindowRevealed,
  focusPairedClientWindow,
  revealPairedClientWindow,
  type RevealablePairedClient
} from './paired-client-window-reveal'

describe('assertPairedClientWindowRevealed', () => {
  it('accepts a window that the reveal made visible', () => {
    expect(() =>
      assertPairedClientWindowRevealed({
        isVisible: true,
        wasVisible: false,
        windowCount: 1
      })
    ).not.toThrow()
  })

  it('accepts a window that was already visible', () => {
    expect(() =>
      assertPairedClientWindowRevealed({
        isVisible: true,
        wasVisible: true,
        windowCount: 1
      })
    ).not.toThrow()
  })

  it('rejects a client with no window instead of letting the spec time out on a click', () => {
    expect(() =>
      assertPairedClientWindowRevealed({
        isVisible: false,
        wasVisible: false,
        windowCount: 0
      })
    ).toThrow(/no BrowserWindow/)
  })

  it('rejects a window that stays hidden after showInactive()', () => {
    expect(() =>
      assertPairedClientWindowRevealed({
        isVisible: false,
        wasVisible: false,
        windowCount: 2
      })
    ).toThrow(/stayed hidden after showInactive\(\)/)
  })
})

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
