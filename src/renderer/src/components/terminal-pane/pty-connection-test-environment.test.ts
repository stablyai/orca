import { describe, expect, it, vi } from 'vitest'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

describe('pty-connection test environment', () => {
  it('stops real timers a test leaves behind so they cannot fire into the next test', async () => {
    await installTerminalTestGlobals()
    let fired = 0
    // Stand-ins for an undisposed session's retry and poll loops.
    setTimeout(() => {
      fired += 1
    }, 5)
    setInterval(() => {
      fired += 1
    }, 5)

    await restoreTerminalTestGlobals()
    await new Promise<void>((resolve) => setTimeout(resolve, 40))

    expect(fired).toBe(0)
  })

  it('clears, from an instance re-imported after resetModules, timers started before the reset', async () => {
    await installTerminalTestGlobals()
    let fired = 0
    // Long enough to stay pending through the re-import below.
    setTimeout(() => {
      fired += 1
    }, 200)
    setInterval(() => {
      fired += 1
    }, 200)

    vi.resetModules()
    const reloaded = await import('./pty-connection-test-environment')
    await reloaded.installTerminalTestGlobals()
    await reloaded.restoreTerminalTestGlobals()
    await new Promise<void>((resolve) => setTimeout(resolve, 300))

    expect(fired).toBe(0)
  })
})
