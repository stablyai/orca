import { describe, expect, it, vi } from 'vitest'
import { createStaleMouseTrackingGuard } from './stale-mouse-tracking-guard'

type Foreground = Awaited<
  ReturnType<Parameters<typeof createStaleMouseTrackingGuard>[0]['readConfirmedForeground']>
>

function setup(
  foreground: Foreground,
  overrides: {
    armed?: () => boolean
    binding?: () => { ptyId: string; incarnationId: string | null } | null
  } = {}
) {
  let clock = 0
  const groundToShell = vi.fn()
  const readConfirmedForeground = vi.fn(async () => foreground)
  const guard = createStaleMouseTrackingGuard({
    getBinding: overrides.binding ?? (() => ({ ptyId: 'pty-1', incarnationId: null })),
    isTrackablePtyId: () => true,
    isMouseTrackingArmed: overrides.armed ?? (() => true),
    readConfirmedForeground,
    groundToShell,
    now: () => clock
  })
  return {
    guard,
    groundToShell,
    readConfirmedForeground,
    advance: (ms: number) => {
      clock += ms
    }
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('createStaleMouseTrackingGuard', () => {
  it('grounds the modes when a mouse report finds a shell in the foreground', async () => {
    const { guard, groundToShell } = setup({ processName: 'sh', remoteEvidenceVerdict: null })
    guard.observeUserInput(true)
    await settle()
    expect(groundToShell).toHaveBeenCalledTimes(1)
  })

  it('leaves a live program that owns the mouse alone', async () => {
    const { guard, groundToShell } = setup({ processName: 'nvim', remoteEvidenceVerdict: null })
    guard.observeUserInput(true)
    await settle()
    expect(groundToShell).not.toHaveBeenCalled()
  })

  it('does not ground on remote evidence that is not live', async () => {
    const { guard, groundToShell } = setup({
      processName: 'bash',
      remoteEvidenceVerdict: 'unverifiable'
    })
    guard.observeUserInput(true)
    await settle()
    expect(groundToShell).not.toHaveBeenCalled()
  })

  it('does not read the foreground when no mouse mode is armed', async () => {
    const { guard, readConfirmedForeground } = setup(
      { processName: 'sh', remoteEvidenceVerdict: null },
      { armed: () => false }
    )
    guard.observeUserInput(true)
    await settle()
    expect(readConfirmedForeground).not.toHaveBeenCalled()
  })

  it('reads the foreground once per cooldown however many reports arrive', async () => {
    const { guard, readConfirmedForeground, advance } = setup({
      processName: 'nvim',
      remoteEvidenceVerdict: null
    })
    guard.observeUserInput(true)
    guard.observeUserInput(true)
    await settle()
    guard.observeUserInput(true)
    expect(readConfirmedForeground).toHaveBeenCalledTimes(1)
    advance(2_000)
    guard.observeUserInput(true)
    expect(readConfirmedForeground).toHaveBeenCalledTimes(2)
  })

  it('drops a verdict for a PTY the pane has since rebound', async () => {
    let ptyId = 'pty-1'
    const { guard, groundToShell } = setup(
      { processName: 'sh', remoteEvidenceVerdict: null },
      { binding: () => ({ ptyId, incarnationId: null }) }
    )
    guard.observeUserInput(true)
    ptyId = 'pty-2'
    await settle()
    expect(groundToShell).not.toHaveBeenCalled()
  })

  it('drops a verdict when the same PTY id comes back as a new incarnation', async () => {
    let incarnationId = 'a'
    const { guard, groundToShell } = setup(
      { processName: 'sh', remoteEvidenceVerdict: null },
      { binding: () => ({ ptyId: 'pty-1', incarnationId }) }
    )
    guard.observeUserInput(true)
    incarnationId = 'b'
    await settle()
    expect(groundToShell).not.toHaveBeenCalled()
  })

  it('probes the new binding while a read for the old one is still pending', async () => {
    let ptyId = 'pty-1'
    const release: (() => void)[] = []
    const groundToShell = vi.fn()
    const readConfirmedForeground = vi.fn(
      () =>
        new Promise<Foreground>((resolve) => {
          release.push(() => resolve({ processName: 'sh', remoteEvidenceVerdict: null }))
        })
    )
    const guard = createStaleMouseTrackingGuard({
      getBinding: () => ({ ptyId, incarnationId: null }),
      isTrackablePtyId: () => true,
      isMouseTrackingArmed: () => true,
      readConfirmedForeground,
      groundToShell,
      now: () => 0
    })
    guard.observeUserInput(true)
    ptyId = 'pty-2'
    guard.observeUserInput(true)
    expect(readConfirmedForeground).toHaveBeenCalledTimes(2)
    release.forEach((fn) => fn())
    await settle()
    expect(groundToShell).toHaveBeenCalledTimes(1)
  })

  it('drops a verdict when typed input may have started a new program', async () => {
    const { guard, groundToShell } = setup({ processName: 'sh', remoteEvidenceVerdict: null })
    guard.observeUserInput(true)
    guard.observeUserInput(false)
    await settle()
    expect(groundToShell).not.toHaveBeenCalled()
  })
})
