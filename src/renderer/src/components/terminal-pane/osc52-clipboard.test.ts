import { describe, expect, it, vi } from 'vitest'
import {
  createOsc52OscHandler,
  handleOsc52ClipboardRequest,
  parseOsc52,
  resolveOsc52ClipboardGate
} from './osc52-clipboard'

function b64(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64')
}

describe('parseOsc52', () => {
  it('decodes the canonical clipboard write payload', () => {
    const result = parseOsc52(`c;${b64('hello world')}`)
    expect(result).toEqual({ kind: 'write', selections: 'c', text: 'hello world' })
  })

  it('preserves multi-byte UTF-8', () => {
    const result = parseOsc52(`c;${b64('café — 日本語')}`)
    expect(result).toEqual({ kind: 'write', selections: 'c', text: 'café — 日本語' })
  })

  it('accepts combined selection letters (e.g. primary + clipboard)', () => {
    const result = parseOsc52(`pc;${b64('dual')}`)
    expect(result).toEqual({ kind: 'write', selections: 'pc', text: 'dual' })
  })

  it('accepts numeric select-buffer indices', () => {
    const result = parseOsc52(`s0;${b64('buffered')}`)
    expect(result).toEqual({ kind: 'write', selections: 's0', text: 'buffered' })
  })

  it('flags clipboard queries without decoding — we must not answer them', () => {
    // Why: answering would leak the user's clipboard to any process writing
    // to the PTY. The lifecycle handler drops queries on the floor.
    expect(parseOsc52('c;?')).toEqual({ kind: 'query' })
  })

  it('tolerates whitespace in the base64 payload', () => {
    const replaceSpy = vi.spyOn(String.prototype, 'replace')
    const encoded = b64('multi-line data that got wrapped')
    const wrapped = `${encoded.slice(0, 10)}\n${encoded.slice(10)}`
    const result = parseOsc52(`c;${wrapped}`)
    const replaceCalls = replaceSpy.mock.calls.length

    expect(replaceCalls).toBe(0)
    expect(result).toEqual({
      kind: 'write',
      selections: 'c',
      text: 'multi-line data that got wrapped'
    })
  })

  it('rejects missing separator', () => {
    expect(parseOsc52(b64('no-semicolon'))).toMatchObject({ kind: 'invalid' })
  })

  it('treats an empty selection list as clipboard, the way tmux emits it', () => {
    // Why: tmux copies via `\e]52;;<base64>` with no selection letter, so
    // rejecting empty Pc broke tmux copy. Zellij always sends an explicit 'c'/'p'.
    expect(parseOsc52(`;${b64('from tmux')}`)).toEqual({
      kind: 'write',
      selections: 'c',
      text: 'from tmux'
    })
  })

  it('still refuses to answer a query when Pc is empty', () => {
    expect(parseOsc52(';?')).toEqual({ kind: 'query' })
  })

  it('rejects an empty payload instead of blanking the clipboard', () => {
    // Why: this is XTerm's "clear the selection", which we decline to honor — with
    // the gate default-on, any PTY could otherwise blank the clipboard for free.
    expect(parseOsc52(';')).toMatchObject({ kind: 'invalid' })
    expect(parseOsc52('c;')).toMatchObject({ kind: 'invalid' })
    expect(parseOsc52('c;   ')).toMatchObject({ kind: 'invalid' })
  })

  it('rejects unknown selection letters', () => {
    expect(parseOsc52(`x;${b64('x')}`)).toMatchObject({ kind: 'invalid' })
  })

  it('rejects non-base64 garbage', () => {
    expect(parseOsc52('c;!!!not-base64!!!')).toMatchObject({ kind: 'invalid' })
  })

  it('rejects payloads larger than the size cap', () => {
    const huge = 'A'.repeat(128 * 1024 + 100) // valid base64 alphabet char
    expect(parseOsc52(`c;${huge}`)).toMatchObject({ kind: 'invalid' })
  })
})

describe('handleOsc52ClipboardRequest', () => {
  it('writes valid OSC 52 clipboard payloads when enabled', () => {
    const writeClipboardText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)

    expect(
      handleOsc52ClipboardRequest(`c;${b64('from remote')}`, {
        allowClipboardWrite: true,
        writeClipboardText
      })
    ).toBe(true)

    expect(writeClipboardText).toHaveBeenCalledWith('from remote')
  })

  it('surfaces a blocked valid write when OSC 52 clipboard writes are disabled', () => {
    const writeClipboardText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
    const onBlockedWrite = vi.fn()

    expect(
      handleOsc52ClipboardRequest(`c;${b64('from remote')}`, {
        allowClipboardWrite: false,
        writeClipboardText,
        onBlockedWrite
      })
    ).toBe(true)

    expect(writeClipboardText).not.toHaveBeenCalled()
    expect(onBlockedWrite).toHaveBeenCalledTimes(1)
  })

  it('never answers a clipboard query even with writes enabled', () => {
    // A guard, not coverage of this change: queries were already refused. It matters
    // more now only because default-on makes `allowClipboardWrite: true` the norm.
    const writeClipboardText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)

    for (const query of ['c;?', ';?']) {
      expect(
        handleOsc52ClipboardRequest(query, { allowClipboardWrite: true, writeClipboardText })
      ).toBe(true)
    }

    expect(writeClipboardText).not.toHaveBeenCalled()
  })

  it('routes every selection kind to the system clipboard, including bare PRIMARY', () => {
    // Pins today's behavior rather than endorsing it: `selections` is parsed but never
    // consulted, so a `p`-only write lands in CLIPBOARD. Routing it to the PRIMARY sink
    // on Linux is a live question — this test is what makes that a deliberate break.
    const writeClipboardText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)

    for (const selections of ['p', 'q', 's0', 'pc']) {
      handleOsc52ClipboardRequest(`${selections};${b64(`via ${selections}`)}`, {
        allowClipboardWrite: true,
        writeClipboardText
      })
    }

    expect(writeClipboardText.mock.calls.map(([text]) => text)).toEqual([
      'via p',
      'via q',
      'via s0',
      'via pc'
    ])
  })

  it('does not surface blocked queries because Orca must not answer them', () => {
    const onBlockedWrite = vi.fn()

    handleOsc52ClipboardRequest('c;?', {
      allowClipboardWrite: false,
      writeClipboardText: vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined),
      onBlockedWrite
    })

    expect(onBlockedWrite).not.toHaveBeenCalled()
  })

  it('surfaces host clipboard write failures for OSC 52 requests', async () => {
    const onWriteFailure = vi.fn()

    handleOsc52ClipboardRequest(`c;${b64('from tui')}`, {
      allowClipboardWrite: true,
      writeClipboardText: vi
        .fn<(text: string) => Promise<void>>()
        .mockRejectedValue(new Error('clipboard unchanged')),
      onWriteFailure
    })

    await vi.waitFor(() => expect(onWriteFailure).toHaveBeenCalledTimes(1))
  })
})

describe('createOsc52OscHandler', () => {
  function setup(
    overrides: {
      settingEnabled?: boolean | null
      replaying?: boolean
      writeClipboardText?: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>
      showWriteFailedToast?: ReturnType<typeof vi.fn<() => void>>
    } = {}
  ) {
    const settingEnabled = 'settingEnabled' in overrides ? overrides.settingEnabled : true
    const writeClipboardText =
      overrides.writeClipboardText ??
      vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
    const showBlockedWriteToast = vi.fn()
    const showWriteFailedToast = overrides.showWriteFailedToast ?? vi.fn()
    const handler = createOsc52OscHandler({
      getSettingEnabled: () => settingEnabled,
      getReplaying: () => overrides.replaying ?? false,
      writeClipboardText,
      showBlockedWriteToast,
      showWriteFailedToast
    })
    return { handler, writeClipboardText, showBlockedWriteToast, showWriteFailedToast }
  }

  it('writes through to the clipboard for a live pane', async () => {
    const { handler, writeClipboardText } = setup()
    expect(handler(`c;${b64('live copy')}`)).toBe(true)
    await Promise.resolve()
    expect(writeClipboardText).toHaveBeenCalledWith('live copy')
  })

  it('coalesces a flood of writes into one clipboard call', async () => {
    // Why: a 15-byte sequence repeated across one hostile chunk would otherwise fire
    // a million IPC round-trips and native clipboard writes. Last write still wins.
    const { handler, writeClipboardText } = setup()
    for (let i = 0; i < 1000; i++) {
      handler(`c;${b64(`copy ${i}`)}`)
    }
    await Promise.resolve()
    expect(writeClipboardText).toHaveBeenCalledExactlyOnceWith('copy 999')
  })

  it('does not coalesce across separate turns', async () => {
    const { handler, writeClipboardText } = setup()
    handler(`c;${b64('first')}`)
    await Promise.resolve()
    handler(`c;${b64('second')}`)
    await Promise.resolve()
    expect(writeClipboardText).toHaveBeenNthCalledWith(1, 'first')
    expect(writeClipboardText).toHaveBeenNthCalledWith(2, 'second')
  })

  it('reads the gate inputs at fire time so a mid-session toggle applies', async () => {
    // Why getters, not values: settings hydrate and toggle after the handler is registered.
    let enabled = false
    const writeClipboardText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
    const handler = createOsc52OscHandler({
      getSettingEnabled: () => enabled,
      getReplaying: () => false,
      writeClipboardText,
      showBlockedWriteToast: vi.fn()
    })

    handler(`c;${b64('before')}`)
    await Promise.resolve()
    expect(writeClipboardText).not.toHaveBeenCalled()

    enabled = true
    handler(`c;${b64('after')}`)
    await Promise.resolve()
    expect(writeClipboardText).toHaveBeenCalledExactlyOnceWith('after')
  })

  // The coalesced write runs in a microtask, outside the parser handler xterm guards, so
  // a bridge failure there escapes the pane as an uncaught error instead of a failed copy.
  it.each([
    [
      // Dropping the try/catch turns this into an uncaught exception that fails the run.
      'a clipboard bridge that throws synchronously',
      vi.fn<(text: string) => Promise<void>>(() => {
        throw new Error('clipboard unavailable')
      })
    ],
    [
      // Not revert-proof on its own — dropping the `?.` turns this into a TypeError the
      // try/catch also swallows. It pins the behavior: a bad bridge must not crash the pane.
      'a preload whose bridge returns nothing',
      vi.fn<(text: string) => Promise<void>>(() => undefined as unknown as Promise<void>)
    ]
  ])('survives %s', async (_label, writeClipboardText) => {
    const { handler } = setup({ writeClipboardText })

    expect(handler(`c;${b64('copy me')}`)).toBe(true)
    await Promise.resolve()
    await Promise.resolve()

    expect(writeClipboardText).toHaveBeenCalledWith('copy me')
  })

  it('surfaces a rejected clipboard write without leaking an unhandled rejection', async () => {
    // Why the listener: an unhandled rejection here does not fail this suite on its own,
    // so without it the `.catch` on the coalesced write is deletable with nothing going red.
    const unhandled: unknown[] = []
    const record = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', record)
    const written: string[] = []
    const showWriteFailedToast = vi.fn(() => {
      throw new Error('toast unavailable')
    })
    try {
      // Why not vi.fn here: the spy tracks settled results, which marks the rejection
      // handled and hides exactly the leak this test exists to catch.
      const handler = createOsc52OscHandler({
        getSettingEnabled: () => true,
        getReplaying: () => false,
        writeClipboardText: (text) => {
          written.push(text)
          return Promise.reject(new Error('denied by OS'))
        },
        showBlockedWriteToast: vi.fn(),
        showWriteFailedToast
      })

      expect(handler(`c;${b64('copy me')}`)).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 10))
    } finally {
      process.off('unhandledRejection', record)
    }

    expect(written).toEqual(['copy me'])
    expect(unhandled).toEqual([])
    expect(showWriteFailedToast).toHaveBeenCalledTimes(1)
  })

  it('surfaces a synchronous clipboard bridge throw as a failed write toast', async () => {
    const showWriteFailedToast = vi.fn(() => {
      throw new Error('toast unavailable')
    })
    const { handler } = setup({
      writeClipboardText: vi.fn<(text: string) => Promise<void>>(() => {
        throw new Error('clipboard unavailable')
      }),
      showWriteFailedToast
    })

    expect(handler(`c;${b64('copy me')}`)).toBe(true)
    await Promise.resolve()
    await Promise.resolve()

    expect(showWriteFailedToast).toHaveBeenCalledTimes(1)
  })

  it('keeps coalescing after a failed write instead of wedging the pane', async () => {
    // Why: a stranded flush latch silently kills clipboard copy for the rest of the session.
    // Today two things prevent it — the latch resets before the write, and the try/catch means
    // the microtask reaches its end either way — so this binds the pair, not the ordering alone.
    const writeClipboardText = vi
      .fn<(text: string) => Promise<void>>()
      .mockImplementationOnce(() => {
        throw new Error('clipboard unavailable')
      })
      .mockResolvedValue(undefined)
    const { handler } = setup({ writeClipboardText })

    handler(`c;${b64('first')}`)
    await Promise.resolve()
    handler(`c;${b64('second')}`)
    await Promise.resolve()

    expect(writeClipboardText).toHaveBeenNthCalledWith(2, 'second')
  })

  it('drops a replayed write and stays silent about it', async () => {
    const { handler, writeClipboardText, showBlockedWriteToast } = setup({ replaying: true })
    expect(handler(`c;${b64('stale scrollback copy')}`)).toBe(true)
    await Promise.resolve()
    expect(writeClipboardText).not.toHaveBeenCalled()
    expect(showBlockedWriteToast).not.toHaveBeenCalled()
  })

  it('toasts only for a real opt-out, never for unhydrated settings', async () => {
    const optedOut = setup({ settingEnabled: false })
    optedOut.handler(`c;${b64('blocked')}`)
    expect(optedOut.showBlockedWriteToast).toHaveBeenCalledTimes(1)

    const unhydrated = setup({ settingEnabled: null })
    unhydrated.handler(`c;${b64('blocked')}`)
    await Promise.resolve()
    expect(unhydrated.writeClipboardText).not.toHaveBeenCalled()
    expect(unhydrated.showBlockedWriteToast).not.toHaveBeenCalled()
  })
})

describe('resolveOsc52ClipboardGate', () => {
  it('allows a live write once the setting is on', () => {
    expect(resolveOsc52ClipboardGate({ settingEnabled: true, replaying: false })).toEqual({
      allowClipboardWrite: true,
      shouldSurfaceBlockedWrite: false
    })
  })

  it('drops replayed writes so restore cannot clobber the clipboard', () => {
    // Why: reattach re-writes recorded PTY bytes through the same parser, so an old
    // copy would silently overwrite what the user has copied since (#10588).
    expect(resolveOsc52ClipboardGate({ settingEnabled: true, replaying: true })).toEqual({
      allowClipboardWrite: false,
      shouldSurfaceBlockedWrite: false
    })
  })

  it('surfaces the blocked toast only for a real opt-out', () => {
    expect(resolveOsc52ClipboardGate({ settingEnabled: false, replaying: false })).toEqual({
      allowClipboardWrite: false,
      shouldSurfaceBlockedWrite: true
    })
  })

  it('stays quiet when a write races settings hydration', () => {
    // Why: the toast latches once per renderer session; an unhydrated read looks
    // blocked even though the default is on, so burning it there hides the real one.
    for (const settingEnabled of [null, undefined]) {
      expect(resolveOsc52ClipboardGate({ settingEnabled, replaying: false })).toEqual({
        allowClipboardWrite: false,
        shouldSurfaceBlockedWrite: false
      })
    }
  })
})
