import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock, resolveForegroundMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  resolveForegroundMock: vi.fn()
}))

vi.mock('node-pty', () => ({ spawn: spawnMock }))
vi.mock('../../src/main/pwsh', () => ({ isPwshAvailable: vi.fn(() => false) }))
vi.mock('../../src/main/providers/windows-powershell-executable', () => ({
  resolveWindowsPowerShellExecutablePath: () =>
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  resolveWindowsPowerShellSpawnChain: () => [
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  ],
  getWindowsCmdPath: () => 'C:\\Windows\\System32\\cmd.exe'
}))
vi.mock('../../src/main/providers/agent-foreground-process', () => ({
  resolveAgentForegroundProcessWithAvailability: async (...args: unknown[]) => {
    const value = await resolveForegroundMock(...args)
    return value && typeof value === 'object' && 'available' in value
      ? value
      : { available: true, processName: value }
  }
}))

import { createPtySubprocess } from '../../src/main/daemon/pty-subprocess'
import { createPaneForegroundAgentTracker } from '../../src/renderer/src/components/terminal-pane/pane-foreground-agent-tracker'

function mockWindowsPty() {
  const exitListeners: ((event: { exitCode: number }) => void)[] = []
  return {
    pid: 12345,
    process: 'powershell.exe',
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onExit: vi.fn((callback: (event: { exitCode: number }) => void) => {
      exitListeners.push(callback)
      return { dispose: vi.fn() }
    })
  }
}

describe('daemon foreground confirmation composes with pane tracking', () => {
  let platform: PropertyDescriptor | undefined

  beforeEach(() => {
    vi.useFakeTimers()
    spawnMock.mockReset()
    resolveForegroundMock.mockReset()
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
  })

  afterEach(() => {
    vi.useRealTimers()
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  function createComposedTracker(publish: ReturnType<typeof vi.fn>) {
    const handle = createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
    const tracker = createPaneForegroundAgentTracker({
      getPtyId: () => 'pty-1',
      isTrackablePtyId: () => true,
      readForegroundProcess: () => handle.confirmForegroundProcess!(),
      publish,
      hasKnownAgentIdentity: () => true
    })
    return { handle, tracker }
  }

  it('keeps a restored Droid through a scan resolving after the old cache window', async () => {
    spawnMock.mockReturnValue(mockWindowsPty())
    let resolveFresh!: (value: string) => void
    resolveForegroundMock.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveFresh = resolve
      })
    )
    const publish = vi.fn()
    const { tracker } = createComposedTracker(publish)

    tracker.onVisiblePtyBound(true)
    await vi.advanceTimersByTimeAsync(350)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(publish).not.toHaveBeenCalled()
    resolveFresh('droid')
    await vi.advanceTimersByTimeAsync(0)

    expect(publish).toHaveBeenCalledExactlyOnceWith({
      agent: 'droid',
      routingTrusted: true,
      shellForeground: false
    })
    expect(resolveForegroundMock).toHaveBeenCalledTimes(1)
  })

  it('clears launch identity after one fresh scan confirms a real shell exit', async () => {
    spawnMock.mockReturnValue(mockWindowsPty())
    resolveForegroundMock.mockResolvedValue('powershell.exe')
    const publish = vi.fn()
    const { tracker } = createComposedTracker(publish)

    tracker.onCommandFinished()
    await vi.advanceTimersByTimeAsync(350)

    expect(publish).toHaveBeenCalledExactlyOnceWith({ agent: null, shellForeground: true })
    expect(resolveForegroundMock).toHaveBeenCalledTimes(1)
  })

  it('fails closed without claiming shell when every fresh scan is unavailable', async () => {
    spawnMock.mockReturnValue(mockWindowsPty())
    resolveForegroundMock.mockResolvedValue({
      available: false,
      processName: 'powershell.exe'
    })
    const publish = vi.fn()
    const { tracker } = createComposedTracker(publish)

    tracker.onCommandFinished()
    await vi.advanceTimersByTimeAsync(350 + 1_200 + 6_000)

    expect(publish).toHaveBeenCalledExactlyOnceWith({ agent: null, shellForeground: false })
    expect(resolveForegroundMock).toHaveBeenCalledTimes(3)
  })
})
