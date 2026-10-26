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
    // Answering queries would expose clipboard contents to any PTY writer.
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
    // tmux emits empty Pc via Ms; refusing it broke copy. Zellij explicitly sends c/p.
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
    // Empty payload is XTerm’s clear-selection request; default-on must not let arbitrary PTYs blank the clipboard.
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
    const huge = 'A'.repeat(128 * 1024 + 100)
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
    // Queries already refused; retain that guarantee with writes enabled by default.
    const writeClipboardText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)

    for (const query of ['c;?', ';?']) {
      expect(
        handleOsc52ClipboardRequest(query, { allowClipboardWrite: true, writeClipboardText })
      ).toBe(true)
    }

    expect(writeClipboardText).not.toHaveBeenCalled()
  })

  it('routes every selection kind to the system clipboard, including bare PRIMARY', () => {
    // All parsed selections currently route to CLIPBOARD, including Linux PRIMARY; pin behavior until a deliberate routing change.
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
    // A hostile chunk can trigger a million native writes; coalescing must retain the last.
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

  // Microtask writes run outside xterm’s parser guard; bridge failures must not escape as uncaught errors.
  it.each([
    [
      // Dropping the try/catch turns this into an uncaught exception that fails the run.
      'a clipboard bridge that throws synchronously',
      vi.fn<(text: string) => Promise<void>>(() => {
        throw new Error('clipboard unavailable')
      })
    ],
    [
      // The outer catch also masks missing optional chaining; this pins bad-bridge behavior, not that syntax.
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
    // This suite does not fail unhandled rejections automatically; listen explicitly to catch removal of the rejection handler.
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
      // Spies track settled results and mark rejections handled, hiding the leak under test.
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
    // A stranded flush latch disables copy for the session; this pins reset plus error handling, not their order alone.
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
  it('stays quiet when a write races settings hydration', () => {
    // Pre-hydration reads look blocked despite default-on; consuming the once-per-session toast hides real refusals.
    for (const settingEnabled of [null, undefined]) {
      expect(resolveOsc52ClipboardGate({ settingEnabled, replaying: false })).toEqual({
        allowClipboardWrite: false,
        shouldSurfaceBlockedWrite: false
      })
    }
  })
})
