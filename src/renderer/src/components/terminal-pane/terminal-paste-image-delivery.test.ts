import { afterEach, describe, expect, it, vi } from 'vitest'
import { executeTerminalPastePlan, planTerminalPaste } from './terminal-paste-coordinator'

function imagePlan(chunked = false) {
  return planTerminalPaste({
    text: '/tmp/image.png',
    source: 'programmatic',
    target: {
      kind: 'terminal',
      paneId: 1,
      leafId: 'leaf',
      ptyId: 'image-delivery-pty',
      runtime: { platform: 'linux', kind: 'local', runtimeKey: 'local:linux' }
    },
    forceBracketedPaste: true,
    ...(chunked ? { maxDirectBytes: 4, maxChunkBytes: 4 } : {})
  })
}

afterEach(() => vi.useRealTimers())

describe.each([false, true])('image handoff with chunked=%s', (chunked) => {
  it('waits for host release before writing and releases once per paste', async () => {
    const events: string[] = []
    let release: (() => void) | undefined
    const beforeDelivery = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            events.push('released')
            resolve()
          }
        })
    )
    const pasteText = vi.fn(() => {
      events.push('written')
    })
    const writePty = vi.fn(() => {
      events.push('written')
      return true
    })
    const execution = executeTerminalPastePlan(imagePlan(chunked), {
      beforeDelivery,
      pasteText,
      writePty,
      isTargetCurrent: () => true,
      yieldToEventLoop: async () => {}
    })
    await vi.waitFor(() => expect(beforeDelivery).toHaveBeenCalledOnce())
    expect(pasteText).not.toHaveBeenCalled()
    expect(writePty).not.toHaveBeenCalled()
    release?.()
    expect(await execution).toMatchObject({ status: 'pasted' })
    expect(events[0]).toBe('released')
    expect(events.slice(1)).toContain('written')
    expect(beforeDelivery).toHaveBeenCalledOnce()
  })

  it('rechecks session authority after release', async () => {
    let current = true
    const pasteText = vi.fn()
    const writePty = vi.fn()
    const execution = await executeTerminalPastePlan(imagePlan(chunked), {
      beforeDelivery: async () => {
        current = false
      },
      pasteText,
      writePty,
      isTargetCurrent: () => current
    })
    expect(execution).toMatchObject({ status: 'cancelled', reason: 'stale-target' })
    expect(pasteText).not.toHaveBeenCalled()
    expect(writePty).not.toHaveBeenCalled()
  })

  it('does not write later if release completes after its timeout', async () => {
    vi.useFakeTimers()
    let release: (() => void) | undefined
    const beforeDelivery = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const pasteText = vi.fn()
    const writePty = vi.fn()
    const execution = executeTerminalPastePlan(imagePlan(chunked), {
      beforeDelivery,
      pasteText,
      writePty,
      isTargetCurrent: () => true,
      operationTimeoutMs: 100
    })
    await vi.advanceTimersByTimeAsync(101)
    expect(await execution).toMatchObject({ status: 'cancelled', reason: 'operation-timeout' })
    release?.()
    await vi.advanceTimersByTimeAsync(1)
    expect(pasteText).not.toHaveBeenCalled()
    expect(writePty).not.toHaveBeenCalled()
  })
})

it('does not release ownership for an already stale target', async () => {
  const beforeDelivery = vi.fn(async () => {})
  expect(
    await executeTerminalPastePlan(imagePlan(), {
      beforeDelivery,
      pasteText: vi.fn(),
      isTargetCurrent: () => false
    })
  ).toMatchObject({ status: 'cancelled', reason: 'stale-target' })
  expect(beforeDelivery).not.toHaveBeenCalled()
})
