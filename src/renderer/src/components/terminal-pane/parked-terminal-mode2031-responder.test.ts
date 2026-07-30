// Why: a parked tab has no xterm, so this byte sidecar is the only thing that
// answers DECSET 2031. fish toggles 2031 on and off around every prompt, so
// answering the sticky "an h appeared" flag writes `?997;1n` into a shell that
// already handed the tty to a child (#9993).
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ESC = '\x1b'
const PTY_ID = 'pty-parked-2031'

// One fish prompt cycle: subscribe, paint, hand off the tty.
const FISH_PROMPT_HANDOFF = `${ESC}[?2031h${ESC}[0m~/orca ${ESC}[32m❯${ESC}[0m ${ESC}[?2031l`

let sidecarWatcher: ((data: string) => void) | null = null
const unsubscribe = vi.fn()

vi.mock('./pty-data-sidecar-subscriptions', () => ({
  subscribeToPtyData: (_ptyId: string, watcher: (data: string) => void) => {
    sidecarWatcher = watcher
    return unsubscribe
  }
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ settings: { theme: 'dark' as const } })
  }
}))

vi.mock('@/lib/terminal-theme', () => ({
  getSystemPrefersDark: () => true
}))

const { startParkedTerminalMode2031Responder } =
  await import('./parked-terminal-mode2031-responder')

function startResponder(): { sendInput: ReturnType<typeof vi.fn>; feed: (data: string) => void } {
  const sendInput = vi.fn()
  startParkedTerminalMode2031Responder({ ptyId: PTY_ID, sendInput })
  return {
    sendInput,
    feed: (data: string) => sidecarWatcher?.(data)
  }
}

beforeEach(() => {
  sidecarWatcher = null
  vi.clearAllMocks()
})

describe('parked-tab DECSET 2031 responder honors the chunk-final state (#9993)', () => {
  it('does not reply to a subscribe the same chunk withdrew', () => {
    const { sendInput, feed } = startResponder()

    feed(FISH_PROMPT_HANDOFF)

    expect(sendInput).not.toHaveBeenCalled()
  })

  it('replies once to a TUI that subscribes and keeps listening', () => {
    const { sendInput, feed } = startResponder()

    feed(`${ESC}[?2031h`)

    expect(sendInput).toHaveBeenCalledTimes(1)
    expect(sendInput).toHaveBeenCalledWith(`${ESC}[?997;1n`)
  })

  it('stays silent across a run of fish prompts', () => {
    const { sendInput, feed } = startResponder()

    feed(FISH_PROMPT_HANDOFF)
    feed(FISH_PROMPT_HANDOFF)
    feed(FISH_PROMPT_HANDOFF)

    expect(sendInput).not.toHaveBeenCalled()
  })

  it('replies when a TUI subscribes after a prompt cycle in the same chunk', () => {
    const { sendInput, feed } = startResponder()

    feed(`${FISH_PROMPT_HANDOFF}${ESC}[?2031h`)

    expect(sendInput).toHaveBeenCalledTimes(1)
  })

  it('still answers a subscribe split across two chunks', () => {
    const { sendInput, feed } = startResponder()

    feed(`${ESC}[?20`)
    feed('31h')

    expect(sendInput).toHaveBeenCalledTimes(1)
  })

  it('does not reply when the withdrawal is split across two chunks', () => {
    const { sendInput, feed } = startResponder()

    feed(`${ESC}[?2031h prompt ${ESC}[?20`)
    expect(sendInput).not.toHaveBeenCalled()
    feed('31l')

    expect(sendInput).not.toHaveBeenCalled()
  })

  it('does not reply when an unrelated private mode appends a split withdrawal', () => {
    const { sendInput, feed } = startResponder()

    feed(`${ESC}[?2031h prompt ${ESC}[?25`)
    expect(sendInput).not.toHaveBeenCalled()
    feed(';2031l')

    expect(sendInput).not.toHaveBeenCalled()
  })

  it('replies after an ambiguous tail resolves to another mode', () => {
    const { sendInput, feed } = startResponder()

    feed(`${ESC}[?2031h drawing ${ESC}[?20`)
    expect(sendInput).not.toHaveBeenCalled()
    feed('25h')

    expect(sendInput).toHaveBeenCalledTimes(1)
  })
})
