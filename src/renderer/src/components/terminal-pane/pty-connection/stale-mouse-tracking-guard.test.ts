import { describe, expect, it, vi } from 'vitest'
import { createStaleMouseTrackingGuard } from './stale-mouse-tracking-guard'

type Foreground = Awaited<
  ReturnType<Parameters<typeof createStaleMouseTrackingGuard>[0]['readConfirmedForeground']>
>

function setup(
  foreground: Foreground,
  overrides: { armed?: () => boolean; ptyId?: () => string | null } = {}
) {
  let clock = 0
  const groundToShell = vi.fn()
  const readConfirmedForeground = vi.fn(async () => foreground)
  const guard = createStaleMouseTrackingGuard({
    getPtyId: overrides.ptyId ?? (() => 'pty-1'),
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
    guard.observeMouseReport()
    await settle()
    expect(groundToShell).toHaveBeenCalledTimes(1)
  })

  it('leaves a live program that owns the mouse alone', async () => {
    const { guard, groundToShell } = setup({ processName: 'nvim', remoteEvidenceVerdict: null })
    guard.observeMouseReport()
    await settle()
    expect(groundToShell).not.toHaveBeenCalled()
  })

  it('does not ground on remote evidence that is not live', async () => {
    const { guard, groundToShell } = setup({
      processName: 'bash',
      remoteEvidenceVerdict: 'unverifiable'
    })
    guard.observeMouseReport()
    await settle()
    expect(groundToShell).not.toHaveBeenCalled()
  })

  it('does not read the foreground when no mouse mode is armed', async () => {
    const { guard, readConfirmedForeground } = setup(
      { processName: 'sh', remoteEvidenceVerdict: null },
      { armed: () => false }
    )
    guard.observeMouseReport()
    await settle()
    expect(readConfirmedForeground).not.toHaveBeenCalled()
  })

  it('reads the foreground once per cooldown however many reports arrive', async () => {
    const { guard, readConfirmedForeground, advance } = setup({
      processName: 'nvim',
      remoteEvidenceVerdict: null
    })
    guard.observeMouseReport()
    guard.observeMouseReport()
    await settle()
    guard.observeMouseReport()
    expect(readConfirmedForeground).toHaveBeenCalledTimes(1)
    advance(2_000)
    guard.observeMouseReport()
    expect(readConfirmedForeground).toHaveBeenCalledTimes(2)
  })

  it('drops a verdict for a PTY the pane has since rebound', async () => {
    let ptyId = 'pty-1'
    const { guard, groundToShell } = setup(
      { processName: 'sh', remoteEvidenceVerdict: null },
      { ptyId: () => ptyId }
    )
    guard.observeMouseReport()
    ptyId = 'pty-2'
    await settle()
    expect(groundToShell).not.toHaveBeenCalled()
  })
})
