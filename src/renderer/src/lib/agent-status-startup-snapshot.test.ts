import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  registerAgentStatusStartupSnapshotLoader,
  requestAgentStatusStartupSnapshot
} from './agent-status-startup-snapshot'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('agent status startup snapshot coordination', () => {
  it('holds an early request until the loader is registered', async () => {
    let settled = false
    const request = requestAgentStatusStartupSnapshot()
    void request.then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(settled).toBe(false)

    const loader = vi.fn(async () => {})
    const dispose = registerAgentStatusStartupSnapshotLoader(loader)

    await request
    expect(settled).toBe(true)
    expect(loader).toHaveBeenCalledOnce()
    dispose()
  })

  it('awaits the registered loader', async () => {
    let resolve = (): void => {}
    const loader = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done
        })
    )
    const dispose = registerAgentStatusStartupSnapshotLoader(loader)

    const request = requestAgentStatusStartupSnapshot()
    expect(loader).toHaveBeenCalledOnce()
    let settled = false
    void request.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    resolve()
    await request
    expect(settled).toBe(true)
    dispose()
  })

  it('waits for a replacement loader after the current loader is disposed', async () => {
    const firstLoader = vi.fn(async () => {})
    const dispose = registerAgentStatusStartupSnapshotLoader(firstLoader)
    dispose()

    const request = requestAgentStatusStartupSnapshot()
    await Promise.resolve()

    const replacementLoader = vi.fn(async () => {})
    const replacementDispose = registerAgentStatusStartupSnapshotLoader(replacementLoader)
    await request

    expect(firstLoader).not.toHaveBeenCalled()
    expect(replacementLoader).toHaveBeenCalledOnce()
    replacementDispose()
  })
})
