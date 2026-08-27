// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readNativeChatLiveScreen } from './native-chat-live-screen'

function stubSnapshot(
  snapshot: { data?: string; scrollbackAnsi?: string; alternateScreen?: boolean } | null
): () => void {
  const previous = window.api
  const getMainBufferSnapshot = vi.fn(async () => snapshot)
  ;(window as unknown as { api: unknown }).api = { pty: { getMainBufferSnapshot } }
  return () => {
    ;(window as unknown as { api: unknown }).api = previous
  }
}

const parseClaude = (screen: string | null | undefined): string | null =>
  screen?.includes('Claude Code v') ? screen : null

describe('readNativeChatLiveScreen', () => {
  let restore: (() => void) | null = null
  afterEach(() => {
    restore?.()
    restore = null
  })

  it('uses the snapshot when it parses', async () => {
    restore = stubSnapshot({ data: 'Claude Code v2.1.220 snapshot' })
    const result = await readNativeChatLiveScreen({
      ptyId: 'pty-1',
      readTerminalScreen: () => 'Claude Code v2.1.220 xterm',
      parse: parseClaude
    })
    expect(result).toBe('Claude Code v2.1.220 snapshot')
  })

  // Why this exists: a stale main buffer reads back as perfectly good text that
  // simply lacks Claude's header. Falling back only on an empty READ stranded us
  // on it and reported nothing at all.
  it('falls back to the xterm when the snapshot reads fine but does not parse', async () => {
    restore = stubSnapshot({ data: 'stale shell output, no header here' })
    const result = await readNativeChatLiveScreen({
      ptyId: 'pty-1',
      readTerminalScreen: () => 'Claude Code v2.1.220 xterm',
      parse: parseClaude
    })
    expect(result).toBe('Claude Code v2.1.220 xterm')
  })

  // Why: the snapshot's frame IS the alternate screen while a TUI owns it, and
  // that is the only place Claude's status line exists. Discarding it here left
  // a full-screen chat (no mounted xterm) with no source at all.
  it('uses the alternate-screen frame rather than discarding it', async () => {
    restore = stubSnapshot({ data: 'Claude Code v2.1.220 alt frame', alternateScreen: true })
    const result = await readNativeChatLiveScreen({
      ptyId: 'pty-1',
      readTerminalScreen: () => null,
      parse: parseClaude
    })
    expect(result).toBe('Claude Code v2.1.220 alt frame')
  })

  it('falls back to the normal buffer when the frame does not parse', async () => {
    restore = stubSnapshot({
      data: 'alt frame with no banner',
      scrollbackAnsi: 'Claude Code v2.1.220 scrollback',
      alternateScreen: true
    })
    const result = await readNativeChatLiveScreen({
      ptyId: 'pty-1',
      readTerminalScreen: () => null,
      parse: parseClaude
    })
    expect(result).toBe('Claude Code v2.1.220 scrollback')
  })

  it('falls back when the snapshot call throws', async () => {
    const previous = window.api
    ;(window as unknown as { api: unknown }).api = {
      pty: {
        getMainBufferSnapshot: vi.fn(async () => {
          throw new Error('remote host')
        })
      }
    }
    restore = () => {
      ;(window as unknown as { api: unknown }).api = previous
    }
    const result = await readNativeChatLiveScreen({
      ptyId: 'pty-1',
      readTerminalScreen: () => 'Claude Code v2.1.220 xterm',
      parse: parseClaude
    })
    expect(result).toBe('Claude Code v2.1.220 xterm')
  })

  it('parses the xterm directly when there is no pty id', async () => {
    restore = stubSnapshot({ data: 'Claude Code v2.1.220 snapshot' })
    const result = await readNativeChatLiveScreen({
      ptyId: null,
      readTerminalScreen: () => 'Claude Code v2.1.220 xterm',
      parse: parseClaude
    })
    expect(result).toBe('Claude Code v2.1.220 xterm')
  })

  it('reports nothing when neither source parses', async () => {
    restore = stubSnapshot({ data: 'stale output' })
    const result = await readNativeChatLiveScreen({
      ptyId: 'pty-1',
      readTerminalScreen: () => 'also not claude',
      parse: parseClaude
    })
    expect(result).toBeNull()
  })
})
