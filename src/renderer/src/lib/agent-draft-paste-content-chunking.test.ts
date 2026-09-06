import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_DRAFT_PASTE_CHUNK_MAX_BYTES,
  AGENT_DRAFT_PASTE_DIRECT_MAX_BYTES,
  AGENT_DRAFT_PASTE_MAX_BYTES,
  chunkAgentDraftPasteContent,
  iterateAgentDraftPasteContentChunks,
  POST_PASTE_SUBMIT_DELAY_MS,
  sendAgentDraftPasteContent,
  sendBracketedPasteToRunningAgent
} from './agent-paste-draft'

const testState = vi.hoisted(() => ({
  appState: {
    settings: {}
  },
  sendRuntimePtyInputVerified: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => testState.appState
  }
}))

vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  inspectRuntimeTerminalProcess: vi.fn(),
  isRemoteRuntimePtyId: vi.fn(),
  sendRuntimePtyInputVerified: testState.sendRuntimePtyInputVerified
}))

describe('agent draft paste content chunking', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout
    })
    testState.sendRuntimePtyInputVerified.mockReset()
    testState.sendRuntimePtyInputVerified.mockResolvedValue(true)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('streams large running-agent drafts as bounded bracketed chunks before submit', async () => {
    const content = 'x'.repeat(
      AGENT_DRAFT_PASTE_DIRECT_MAX_BYTES + AGENT_DRAFT_PASTE_CHUNK_MAX_BYTES + 7
    )
    const promise = sendBracketedPasteToRunningAgent({
      ptyId: 'pty-1',
      content
    })

    await flushMicrotasks(20)

    const calls = testState.sendRuntimePtyInputVerified.mock.calls
    expect(calls.at(0)).toEqual([{}, 'pty-1', '\x1b[200~'])
    expect(calls.at(-1)?.[2]).toBe('\x1b[201~')
    expect(
      calls
        .slice(1, -1)
        .map((call) => call[2])
        .join('')
    ).toBe(content)
    for (const call of calls.slice(1, -1)) {
      expect((call[2] as string).length).toBeLessThanOrEqual(AGENT_DRAFT_PASTE_CHUNK_MAX_BYTES)
    }

    await vi.advanceTimersByTimeAsync(POST_PASTE_SUBMIT_DELAY_MS)

    await expect(promise).resolves.toBe(true)
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenLastCalledWith({}, 'pty-1', '\r')
  })

  it('normalizes multiline running-agent drafts like terminal paste', async () => {
    const promise = sendBracketedPasteToRunningAgent({
      ptyId: 'pty-1',
      content: 'line one\r\nline two\nline three'
    })

    expect(testState.sendRuntimePtyInputVerified).toHaveBeenCalledWith(
      {},
      'pty-1',
      '\x1b[200~line one\rline two\rline three\x1b[201~'
    )
    await vi.advanceTimersByTimeAsync(POST_PASTE_SUBMIT_DELAY_MS)
    await expect(promise).resolves.toBe(true)
  })

  it('closes bracketed paste and does not submit when a chunked draft write is rejected', async () => {
    testState.sendRuntimePtyInputVerified
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    const content = 'x'.repeat(
      AGENT_DRAFT_PASTE_DIRECT_MAX_BYTES + AGENT_DRAFT_PASTE_CHUNK_MAX_BYTES + 7
    )

    await expect(
      sendBracketedPasteToRunningAgent({
        ptyId: 'pty-1',
        content
      })
    ).resolves.toBe(false)

    expect(testState.sendRuntimePtyInputVerified).toHaveBeenCalledTimes(3)
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenNthCalledWith(
      1,
      {},
      'pty-1',
      '\x1b[200~'
    )
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenNthCalledWith(
      3,
      {},
      'pty-1',
      '\x1b[201~'
    )
    expect(testState.sendRuntimePtyInputVerified.mock.calls.some((call) => call[2] === '\r')).toBe(
      false
    )
  })

  it('sanitizes escape bytes inside chunked agent draft paste content', () => {
    const chunks = chunkAgentDraftPasteContent('before\x1b[201~after😀', 6)

    expect(chunks.at(0)).toBe('\x1b[200~')
    expect(chunks.at(-1)).toBe('\x1b[201~')
    expect(chunks.slice(1, -1).join('')).toBe('before␛[201~after😀')
    expect(chunks.slice(1, -1).join('')).not.toContain('\x1b[201~')
  })

  it('normalizes agent draft line endings before a CRLF chunk boundary', () => {
    const chunks = chunkAgentDraftPasteContent('abc\r\ndef\nghi', 4)

    expect(chunks).toEqual(['\x1b[200~', 'abc\r', 'def\r', 'ghi', '\x1b[201~'])
    expect(chunks.join('')).not.toContain('\n')
  })

  it('chunks escape-heavy agent draft paste without per-character string sanitizer scans', () => {
    const content = Array.from({ length: 64 }, (_value, index) => `draft-${index}\x1b[201~`).join(
      ''
    )
    const includesSpy = vi.spyOn(String.prototype, 'includes')
    const replaceAllSpy = vi.spyOn(String.prototype, 'replaceAll')

    const chunks = chunkAgentDraftPasteContent(content, 12)
    const includesCallCount = includesSpy.mock.calls.length
    const replaceAllCallCount = replaceAllSpy.mock.calls.length
    includesSpy.mockRestore()
    replaceAllSpy.mockRestore()

    expect(chunks.at(0)).toBe('\x1b[200~')
    expect(chunks.at(-1)).toBe('\x1b[201~')
    expect(chunks.slice(1, -1).join('')).not.toContain('\x1b[201~')
    expect(chunks.slice(1, -1).join('')).toContain('␛[201~')
    expect(includesCallCount).toBe(0)
    expect(replaceAllCallCount).toBe(0)
  })

  it('keeps agent draft chunk arrays aligned with lazy chunk iteration', () => {
    const content = 'before\x1b[201~after😀'

    expect(chunkAgentDraftPasteContent(content, 6)).toEqual([
      ...iterateAgentDraftPasteContentChunks(content, 6)
    ])
  })

  it('iterates large agent draft chunks lazily', () => {
    const text = 'x'.repeat(128)
    const codePointAt = vi.spyOn(String.prototype, 'codePointAt')
    const chunks = iterateAgentDraftPasteContentChunks(text, 8)

    expect(chunks.next()).toEqual({ done: false, value: '\x1b[200~' })
    expect(chunks.next()).toEqual({ done: false, value: 'x'.repeat(8) })
    expect(codePointAt.mock.calls.length).toBeLessThan(text.length)

    codePointAt.mockRestore()
  })

  it('yields during large accepted-size preflight before writing agent draft chunks', async () => {
    const content = 'x'.repeat(AGENT_DRAFT_PASTE_DIRECT_MAX_BYTES + 300 * 1024)
    const promise = sendAgentDraftPasteContent({}, 'pty-1', content)

    await flushMicrotasks(5)
    expect(testState.sendRuntimePtyInputVerified).not.toHaveBeenCalled()

    await vi.runOnlyPendingTimersAsync()
    await flushMicrotasks(10)

    expect(testState.sendRuntimePtyInputVerified).toHaveBeenCalledWith({}, 'pty-1', '\x1b[200~')
    await expect(promise).resolves.toBe(true)
  })

  it('rejects oversized agent drafts before any PTY write', async () => {
    await expect(
      sendAgentDraftPasteContent({}, 'pty-1', 'x'.repeat(AGENT_DRAFT_PASTE_MAX_BYTES + 1))
    ).resolves.toBe(false)

    expect(testState.sendRuntimePtyInputVerified).not.toHaveBeenCalled()
  })
})

async function flushMicrotasks(iterations = 2): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve()
  }
}
