// Why: reproduce the issue (pi spinner not reaching the worktree card on macOS)
// entirely in unit-test harness. Pi's titlebar extension emits OSC 0 titles of
// the form `\x1b]0;⠋ π - cwd\x07` (working frames) and `\x1b]0;π - cwd\x07`
// (idle). The electron-level verification showed these chunks reach `pty:data`
// but the store's runtimePaneTitlesByTabId never flips to "⠋ Pi". This file
// pins the transport-level contract: `onTitleChange` must fire for working
// frames, in the normalized form the store consumes.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ESC = '\x1b'
const BEL = '\x07'
const workingFrame = (frame: string): string => `${ESC}]0;${frame} π - cwd${BEL}`
const idleTitle = (): string => `${ESC}]0;π - cwd${BEL}`

describe('createIpcPtyTransport — Pi titlebar spinner signal', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window
  let onData: ((payload: { id: string; data: string }) => void) | null = null

  beforeEach(() => {
    vi.resetModules()
    onData = null
    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          spawn: vi.fn().mockResolvedValue({ id: 'pty-pi' }),
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          onData: vi.fn((cb: (payload: { id: string; data: string }) => void) => {
            onData = cb
            return () => {}
          }),
          onReplay: vi.fn(() => () => {}),
          onExit: vi.fn(() => () => {})
        }
      }
    } as unknown as typeof window
  })

  afterEach(() => {
    if (originalWindow) {
      ;(globalThis as { window: typeof window }).window = originalWindow
    } else {
      delete (globalThis as { window?: typeof window }).window
    }
  })

  it('fires onTitleChange with the normalized working label on each spinner frame', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const onTitleChange = vi.fn()

    const transport = createIpcPtyTransport({ onTitleChange })
    await transport.connect({ url: '', callbacks: {} })

    // Pi boots idle, then agent_start fires and emits working frames, then
    // agent_end flips back to idle. Each frame is its own `pty:data` chunk —
    // matches the node-pty batching behavior I captured from a live session.
    onData?.({ id: 'pty-pi', data: idleTitle() })
    onData?.({ id: 'pty-pi', data: workingFrame('⠋') }) // ⠋
    onData?.({ id: 'pty-pi', data: workingFrame('⠙') }) // ⠙
    onData?.({ id: 'pty-pi', data: workingFrame('⠹') }) // ⠹
    onData?.({ id: 'pty-pi', data: idleTitle() })

    const normalized = onTitleChange.mock.calls.map((c) => c[0])
    // The store only stores the normalized label, which is what the worktree
    // card feeds back into detectAgentStatusFromTitle. The working→idle cycle
    // must surface at least one "⠋ Pi" so the card can classify the pane as
    // 'working' (detectAgentStatusFromTitle('⠋ Pi') === 'working').
    expect(normalized).toContain('⠋ Pi')
    expect(normalized).toContain('Pi')

    transport.disconnect()
  })

  it('fires onTitleChange for working frames via attach() (reattach path)', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const onTitleChange = vi.fn()

    const transport = createIpcPtyTransport({ onTitleChange })
    // Why: reattach is the path taken when a worktree is restored or when
    // tab re-mounting happens mid-session. The transport must still wire up
    // the title observer on this path — otherwise Pi emits spinner frames
    // that never propagate to the store.
    transport.attach({ existingPtyId: 'pty-pi', callbacks: {} })

    onTitleChange.mockClear()

    onData?.({ id: 'pty-pi', data: workingFrame('⠋') })
    onData?.({ id: 'pty-pi', data: workingFrame('⠙') })

    const calls = onTitleChange.mock.calls.map((c) => c[0])
    expect(calls).toContain('⠋ Pi')

    transport.disconnect()
  })

  it('surfaces working even when a single chunk contains multiple spinner frames', async () => {
    // Why: node-pty may coalesce multiple 80ms spinner frames into one
    // `pty:data` event on macOS when the renderer is briefly throttled.
    // extractLastOscTitle returns only the LAST OSC title in the chunk — if
    // a chunk happens to end with the idle title (agent_end fires after the
    // last working frame), the working frames in between must not be the only
    // signal the transport ever saw. The important guarantee is that during
    // an actual working period (before agent_end) at least one chunk's last
    // title is a working frame, and that produces a "⠋ Pi" onTitleChange.
    const { createIpcPtyTransport } = await import('./pty-transport')
    const onTitleChange = vi.fn()

    const transport = createIpcPtyTransport({ onTitleChange })
    await transport.connect({ url: '', callbacks: {} })

    const coalescedWorking = `${workingFrame('⠋')}output\r\n${workingFrame('⠙')}`
    onData?.({ id: 'pty-pi', data: coalescedWorking })

    const calls = onTitleChange.mock.calls.map((c) => c[0])
    expect(calls).toContain('⠋ Pi')

    transport.disconnect()
  })
})
