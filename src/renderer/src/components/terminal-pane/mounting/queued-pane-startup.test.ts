import { describe, expect, it, vi } from 'vitest'
import { createQueuedStartupConsumer, paneOwnsQueuedStartup } from './queued-pane-startup'
import { splitPaneWithOneShotStartup } from '../layout/split/pane-split-startup'

// Setup splits borrow startup for their own payload; only the primary pane may consume the tab’s queued command (STA-4876).
describe('paneOwnsQueuedStartup', () => {
  it('grants ownership only to the pane still holding the queued object', () => {
    const queuedStartup = { command: 'echo queued' }
    const deps: { startup?: { command: string; env?: Record<string, string> } | null } = {
      startup: queuedStartup
    }
    const ownershipAtConnect: boolean[] = []
    const observeConnect = (): void => {
      ownershipAtConnect.push(paneOwnsQueuedStartup(deps.startup, queuedStartup))
    }

    observeConnect()
    deps.startup = null
    splitPaneWithOneShotStartup(deps, { command: 'orca setup' }, () => {
      observeConnect()
      return { id: 2 }
    })
    splitPaneWithOneShotStartup(deps, { command: 'orca issue' }, () => {
      observeConnect()
      return { id: 3 }
    })

    expect(ownershipAtConnect).toEqual([true, false, false])
  })

  // An identical payload distinguishes ownership checks from a startup truthiness check.
  it('denies ownership to a split payload structurally identical to the queued command', () => {
    const queuedStartup = { command: 'orca setup' }

    expect(paneOwnsQueuedStartup({ command: 'orca setup' }, queuedStartup)).toBe(false)
    expect(paneOwnsQueuedStartup(queuedStartup, queuedStartup)).toBe(true)
  })

  it('denies ownership when the tab queued nothing, so an unrelated pane cannot spend a slot', () => {
    expect(paneOwnsQueuedStartup(null, null)).toBe(false)
    expect(paneOwnsQueuedStartup(undefined, undefined)).toBe(false)
    expect(paneOwnsQueuedStartup({ command: 'orca setup' }, null)).toBe(false)
  })
})

describe('createQueuedStartupConsumer', () => {
  it('withholds the consumer from a pane that does not own the queued command', () => {
    const queuedStartup = { command: 'echo queued' }
    const consume = vi.fn()

    expect(
      createQueuedStartupConsumer({ command: 'echo queued' }, queuedStartup, consume, () => true)
    ).toBeUndefined()
    expect(createQueuedStartupConsumer(null, queuedStartup, consume, () => true)).toBeUndefined()
    expect(consume).not.toHaveBeenCalled()
  })

  // Wake/respawn must not consume a command queued after this pane’s first launch.
  it('spends the queued command at most once across repeated spawns', () => {
    const queuedStartup = { command: 'echo queued' }
    const consume = vi.fn()

    const consumer = createQueuedStartupConsumer(queuedStartup, queuedStartup, consume, () => true)
    expect(consumer).toBeTypeOf('function')

    consumer?.()
    consumer?.()
    consumer?.()

    expect(consume).toHaveBeenCalledTimes(1)
  })

  // A replacement queued before first spawn must retain its own launch’s command (STA-4876).
  it('leaves a command that replaced the captured one queued for its own launch', () => {
    const capturedStartup = { command: 'echo captured' }
    let pending: object | null = capturedStartup
    const consume = vi.fn(() => {
      pending = null
    })

    const consumer = createQueuedStartupConsumer(
      capturedStartup,
      capturedStartup,
      consume,
      () => pending === capturedStartup
    )
    const replacement = { command: 'echo replacement' }
    pending = replacement

    consumer?.()

    expect(consume).not.toHaveBeenCalled()
    expect(pending).toBe(replacement)
  })

  // Skipping the original command does not authorize a later respawn to consume its replacement.
  it('does not spend a replacement on a later spawn of the same pane', () => {
    const capturedStartup = { command: 'echo captured' }
    let pending: object | null = { command: 'echo replacement' }
    const consume = vi.fn()

    const consumer = createQueuedStartupConsumer(
      capturedStartup,
      capturedStartup,
      consume,
      () => pending === capturedStartup
    )

    consumer?.()
    pending = capturedStartup
    consumer?.()

    expect(consume).not.toHaveBeenCalled()
  })
})
