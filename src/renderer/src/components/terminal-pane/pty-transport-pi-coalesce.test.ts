// Why: regression guard for the Pi spinner loss. node-pty and the
// main-process 8ms batch window commonly coalesce multiple OSC title updates
// into a single IPC payload. Before the fix, the transport's handler used
// `extractLastOscTitle` and surfaced only the last title — dropping the
// intermediate working frames when Pi's agent_end flushed a trailing idle
// title in the same chunk. The worktree card then never observed the
// working state. Each OSC title in a chunk must reach onTitleChange in
// order so the agent tracker and the store see the working→idle transition.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ESC = '\x1b'
const BEL = '\x07'
const workingFrame = (frame: string): string => `${ESC}]0;${frame} π - cwd${BEL}`
const idleTitle = (): string => `${ESC}]0;π - cwd${BEL}`

describe('pty-transport — coalesced OSC titles from Pi', () => {
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

  it('surfaces working frames even when the chunk ends with a trailing idle title', async () => {
    // Why: Pi's extension emits working frames on `agent_start` and a final
    // idle title on `agent_end`. When the PTY batches those into one IPC
    // payload, a last-title-only reader would see only the idle title and
    // the store would never observe the working state. This is the exact
    // failure mode users hit on fast agents — the spinner never appears.
    const { createIpcPtyTransport } = await import('./pty-transport')
    const onTitleChange = vi.fn()
    const transport = createIpcPtyTransport({ onTitleChange })
    await transport.connect({ url: '', callbacks: {} })

    // One realistic chunk: working frames from setInterval(80ms) followed by
    // agent_end's stopAnimation idle title. All buffered by the node-pty
    // read batch on the main side.
    // agent_end fires stopAnimation -> trailing idle title after working frames
    const chunk = `${workingFrame('⠋')}some response text\r\n${workingFrame('⠙')}more response text\r\n${idleTitle()}`
    onData?.({ id: 'pty-pi', data: chunk })

    const seen = onTitleChange.mock.calls.map((c) => c[0])
    // Users expect the working state to register SOMEWHERE in the sequence,
    // even if extractLastOscTitle only took the last frame. The worktree card
    // renders 'working' as long as detectAgentStatusFromTitle sees a working
    // title — if the intermediate frames are dropped, users never see the
    // spinner on fast-agent prompts.
    expect(seen).toContain('⠋ Pi')
    // Idle must land last so the spinner disappears on agent_end.
    expect(seen.at(-1)).toBe('Pi')

    transport.disconnect()
  })

  it('surfaces working frames when many spinner frames arrive in one chunk', async () => {
    // Why: a slow renderer/DOM event loop can delay main-process flushes,
    // batching 10+ 80ms spinner frames into one IPC event. Every frame must
    // still feed the observer in order.
    const { createIpcPtyTransport } = await import('./pty-transport')
    const onTitleChange = vi.fn()
    const transport = createIpcPtyTransport({ onTitleChange })
    await transport.connect({ url: '', callbacks: {} })

    const framesChars = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
    const chunk = framesChars.map(workingFrame).join('body\r\n')
    onData?.({ id: 'pty-pi', data: chunk })

    const seen = onTitleChange.mock.calls.map((c) => c[0])
    expect(seen).toContain('⠋ Pi')

    transport.disconnect()
  })
})
