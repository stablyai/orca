import { describe, expect, it, vi } from 'vitest'

import { PASTE_PAYLOAD_CORPUS } from '../../lib/paste-payload-corpus'
import { BRACKETED_PASTE_END, BRACKETED_PASTE_START } from './terminal-bracketed-paste'
import { createRedactedPasteExecutionDiagnostic } from './terminal-paste-diagnostics'
import { formatTerminalPasteExecutionError } from './terminal-paste-errors'
import {
  chunkTerminalPastePlan,
  createTerminalPastePayload,
  executeTerminalPastePlan,
  getTerminalPasteOperationTimeoutMs,
  iterateTerminalPastePlanChunks,
  planTerminalPaste,
  planTerminalPasteWithYield,
  TERMINAL_PASTE_OPERATION_TIMEOUT_MS,
  TERMINAL_REMOTE_PASTE_OPERATION_TIMEOUT_MS,
  type TerminalPasteRuntime,
  type TerminalPasteTarget
} from './terminal-paste-coordinator'

const textEncoder = new TextEncoder()

function terminalTarget(overrides: Partial<TerminalPasteTarget> = {}): TerminalPasteTarget {
  return {
    kind: 'terminal',
    paneId: 1,
    leafId: 'leaf-1',
    ptyId: 'pty-1',
    runtime: {
      platform: 'win32',
      runtimeKey: 'local:win32',
      kind: 'local',
      isWindowsConpty: true
    },
    ...overrides
  }
}

function getPastePayloadCorpusText(name: string): string {
  const entry = PASTE_PAYLOAD_CORPUS.find((item) => item.name === name)
  if (!entry) {
    throw new Error(`Missing paste payload corpus case: ${name}`)
  }
  return entry.text
}

const RUNTIME_MATRIX: { name: string; runtime: TerminalPasteRuntime }[] = [
  {
    name: 'Windows host',
    runtime: {
      platform: 'win32',
      runtimeKey: 'local:win32',
      kind: 'local',
      isWindowsConpty: true
    }
  },
  {
    name: 'WSL selected distro',
    runtime: {
      platform: 'linux',
      runtimeKey: 'wsl:Ubuntu-24.04',
      kind: 'wsl'
    }
  },
  {
    name: 'SSH Linux',
    runtime: {
      platform: 'linux',
      runtimeKey: 'ssh:linux-prod',
      kind: 'ssh'
    }
  },
  {
    name: 'SSH Windows',
    runtime: {
      platform: 'win32',
      runtimeKey: 'ssh:windows-prod',
      kind: 'ssh'
    }
  },
  {
    name: 'macOS local',
    runtime: {
      platform: 'darwin',
      runtimeKey: 'local:darwin',
      kind: 'local'
    }
  },
  {
    name: 'Linux remote runtime',
    runtime: {
      platform: 'linux',
      runtimeKey: 'remote-runtime:linux',
      kind: 'remote-runtime'
    }
  }
]

describe('terminal paste coordinator', () => {
  it('builds payload metadata without logging clipboard content', () => {
    const secret = 'token=sk-live-secret\r\nemoji=👩‍💻\nansi=\x1b[31m'
    const payload = createTerminalPastePayload({ text: secret, source: 'keyboard' })
    const plan = planTerminalPaste({
      text: secret,
      source: 'keyboard',
      target: terminalTarget()
    })

    expect(payload.byteLength).toBeGreaterThan(secret.length)
    expect(payload.lineCount).toBe(3)
    expect(payload.hasControlSequences).toBe(true)
    expect(plan.redactedDiagnostic).toContain('content=redacted')
    expect(plan.redactedDiagnostic).toContain('runtime=local:win32')
    expect(plan.redactedDiagnostic).not.toContain('sk-live-secret')
    expect(plan.redactedDiagnostic).not.toContain(secret)
  })

  it('keeps small text on the xterm paste path', async () => {
    const pasteText = vi.fn()
    const writePty = vi.fn()
    const plan = planTerminalPaste({
      text: 'printf "hello"',
      source: 'keyboard',
      target: terminalTarget()
    })

    const result = await executeTerminalPastePlan(plan, {
      pasteText,
      writePty,
      isTargetCurrent: () => true
    })

    expect(result.status).toBe('pasted')
    expect(plan.mode).toBe('direct')
    expect(pasteText).toHaveBeenCalledWith('printf "hello"', { forceBracketedPaste: false })
    expect(writePty).not.toHaveBeenCalled()
  })

  it('forces small Windows multiline paste through bracketed terminal input', async () => {
    const pasteText = vi.fn()
    const plan = planTerminalPaste({
      text: 'one\r\ntwo',
      source: 'keyboard',
      target: terminalTarget(),
      forceBracketedPaste: true
    })

    await executeTerminalPastePlan(plan, {
      pasteText,
      isTargetCurrent: () => true
    })

    expect(plan.mode).toBe('bracketed-terminal')
    expect(pasteText).toHaveBeenCalledWith('one\r\ntwo', { forceBracketedPaste: true })
  })

  it('streams large paste through bounded PTY chunks and yields between chunks', async () => {
    const pasteText = vi.fn()
    const writePty = vi.fn<(data: string) => boolean>(() => true)
    const yieldToEventLoop = vi.fn(async () => {})
    const text = 'path with spaces && unicode 👩‍💻\n'.repeat(6)
    const plan = planTerminalPaste({
      text,
      source: 'context-menu',
      target: terminalTarget({
        runtime: { platform: 'linux', runtimeKey: 'ssh:prod', kind: 'ssh' }
      }),
      maxDirectBytes: 32,
      maxChunkBytes: 24
    })

    const result = await executeTerminalPastePlan(plan, {
      pasteText,
      writePty,
      isTargetCurrent: () => true,
      canContinue: () => true,
      yieldToEventLoop
    })

    expect(result.status).toBe('pasted')
    expect(plan.mode).toBe('chunked')
    expect(plan.runtimeKey).toBe('ssh:prod')
    expect(pasteText).not.toHaveBeenCalled()
    expect(writePty.mock.calls.map((call) => call[0]).join('')).toBe(text)
    expect(writePty.mock.calls.length).toBeGreaterThan(1)
    expect(yieldToEventLoop).toHaveBeenCalledTimes(writePty.mock.calls.length)
  })

  it('bracket-wraps large terminal-mode paste once and preserves newlines', async () => {
    const text = 'alpha\r\nbeta\nbefore\x1b[201~after'
    const plan = planTerminalPaste({
      text,
      source: 'keyboard',
      target: terminalTarget(),
      terminalBracketedPasteMode: true,
      maxDirectBytes: 8,
      maxChunkBytes: 5
    })
    const chunks = chunkTerminalPastePlan(plan)

    expect(chunks[0]).toBe(BRACKETED_PASTE_START)
    expect(chunks.at(-1)).toBe(BRACKETED_PASTE_END)
    expect(chunks.slice(1, -1).join('')).toBe('alpha\r\nbeta\nbefore␛[201~after')
    expect(chunks.slice(1, -1).join('')).not.toContain('\x1b[201~')
  })

  it('chunks escape-heavy bracketed paste without per-character string sanitizer scans', () => {
    const text = Array.from({ length: 64 }, (_value, index) => `part-${index}\x1b[201~`).join('')
    const plan = planTerminalPaste({
      text,
      source: 'keyboard',
      target: terminalTarget(),
      terminalBracketedPasteMode: true,
      maxDirectBytes: 8,
      maxChunkBytes: 12
    })
    const includesSpy = vi.spyOn(String.prototype, 'includes')
    const replaceAllSpy = vi.spyOn(String.prototype, 'replaceAll')

    const chunks = chunkTerminalPastePlan(plan)
    const includesCallCount = includesSpy.mock.calls.length
    const replaceAllCallCount = replaceAllSpy.mock.calls.length
    includesSpy.mockRestore()
    replaceAllSpy.mockRestore()

    expect(chunks[0]).toBe(BRACKETED_PASTE_START)
    expect(chunks.at(-1)).toBe(BRACKETED_PASTE_END)
    expect(chunks.slice(1, -1).join('')).not.toContain('\x1b[201~')
    expect(chunks.slice(1, -1).join('')).toContain('␛[201~')
    expect(includesCallCount).toBe(0)
    expect(replaceAllCallCount).toBe(0)
  })

  it('keeps the array chunk wrapper aligned with lazy chunk iteration', () => {
    const plan = planTerminalPaste({
      text: 'ab😀cd',
      source: 'keyboard',
      target: terminalTarget(),
      maxDirectBytes: 4,
      maxChunkBytes: 4
    })

    expect(chunkTerminalPastePlan(plan)).toEqual([...iterateTerminalPastePlanChunks(plan)])
  })

  it('preserves shared corpus payloads through non-bracketed chunk planning', () => {
    for (const { hasRichText = false, name, text } of PASTE_PAYLOAD_CORPUS) {
      const plan = planTerminalPaste({
        hasRichText,
        text,
        source: 'keyboard',
        target: terminalTarget(),
        maxDirectBytes: 0,
        maxChunkBytes: 7
      })
      const chunks = chunkTerminalPastePlan(plan)

      expect(plan.mode, name).toBe('chunked')
      expect(plan.payload.hasRichText, name).toBe(hasRichText)
      expect(chunks.join(''), name).toBe(text)
      expect(plan.redactedDiagnostic, name).toContain('content=redacted')
      expect(plan.redactedDiagnostic, name).toContain(`rich=${hasRichText}`)
      expect(plan.redactedDiagnostic, name).not.toContain(text)
      expect(
        chunks.every((chunk) => textEncoder.encode(chunk).byteLength <= 7),
        name
      ).toBe(true)
    }
  })

  it('bracket-wraps shared non-control corpus payloads once without rewriting content', () => {
    for (const { expected, hasRichText = false, name, text } of PASTE_PAYLOAD_CORPUS) {
      if (expected.hasControlSequences) {
        continue
      }
      const plan = planTerminalPaste({
        hasRichText,
        text,
        source: 'keyboard',
        target: terminalTarget(),
        terminalBracketedPasteMode: true,
        maxDirectBytes: 0,
        maxChunkBytes: 7
      })
      const chunks = chunkTerminalPastePlan(plan)

      expect(plan.mode, name).toBe('chunked')
      expect(plan.bracketed, name).toBe(true)
      expect(chunks[0], name).toBe(BRACKETED_PASTE_START)
      expect(chunks.at(-1), name).toBe(BRACKETED_PASTE_END)
      expect(chunks.slice(1, -1).join(''), name).toBe(text)
      expect(
        chunks.filter((chunk) => chunk === BRACKETED_PASTE_START),
        name
      ).toHaveLength(1)
      expect(
        chunks.filter((chunk) => chunk === BRACKETED_PASTE_END),
        name
      ).toHaveLength(1)
      expect(plan.redactedDiagnostic, name).not.toContain(text)
    }
  })

  it('preserves newline policy and literal text across terminal runtime identities', async () => {
    const text = getPastePayloadCorpusText('mixed newline text')

    for (const { name, runtime } of RUNTIME_MATRIX) {
      const writePty = vi.fn<(data: string) => boolean>(() => true)
      const plan = planTerminalPaste({
        text,
        source: 'keyboard',
        target: terminalTarget({ runtime }),
        maxDirectBytes: 1,
        maxChunkBytes: 5
      })

      const result = await executeTerminalPastePlan(plan, {
        pasteText: vi.fn(),
        writePty,
        isTargetCurrent: () => true,
        canContinue: () => true,
        yieldToEventLoop: async () => {}
      })

      expect(result.status, name).toBe('pasted')
      expect(plan.newlinePolicy, name).toBe('preserve')
      expect(plan.runtimeKey, name).toBe(runtime.runtimeKey)
      expect(plan.redactedDiagnostic, name).toContain(`runtime=${runtime.runtimeKey}`)
      expect(writePty.mock.calls.map((call) => call[0]).join(''), name).toBe(text)
    }
  })

  it('uses a longer paste safety timeout for network-backed terminal runtimes', () => {
    for (const { name, runtime } of RUNTIME_MATRIX) {
      const plan = planTerminalPaste({
        text: 'echo timeout-policy',
        source: 'keyboard',
        target: terminalTarget({ runtime })
      })

      expect(getTerminalPasteOperationTimeoutMs(plan), name).toBe(
        runtime.kind === 'ssh' || runtime.kind === 'remote-runtime'
          ? TERMINAL_REMOTE_PASTE_OPERATION_TIMEOUT_MS
          : TERMINAL_PASTE_OPERATION_TIMEOUT_MS
      )
    }
  })

  it('does not split astral Unicode when it starts a new terminal chunk', () => {
    const text = `ab${getPastePayloadCorpusText('Unicode')}cd`
    const plan = planTerminalPaste({
      text,
      source: 'keyboard',
      target: terminalTarget(),
      maxDirectBytes: 1,
      maxChunkBytes: 4
    })

    expect(chunkTerminalPastePlan(plan).join('')).toBe(text)
  })

  it('yields during accepted large terminal paste planning before chunk execution', async () => {
    const yieldToEventLoop = vi.fn(async () => {})
    const plan = await planTerminalPasteWithYield({
      text: `${'x'.repeat(32)}\nwith unicode 😀`,
      source: 'app-menu',
      target: terminalTarget({
        runtime: { platform: 'darwin', runtimeKey: 'local:darwin', kind: 'local' }
      }),
      maxDirectBytes: 8,
      measureYieldAfterCodeUnits: 8,
      yieldToEventLoop
    })

    expect(plan.mode).toBe('chunked')
    expect(plan.runtimeKey).toBe('local:darwin')
    expect(plan.payload.lineCount).toBe(2)
    expect(yieldToEventLoop).toHaveBeenCalled()
  })

  it('does not scan remaining large chunks after the first PTY write fails', async () => {
    const text = 'x'.repeat(128)
    const plan = planTerminalPaste({
      text,
      source: 'keyboard',
      target: terminalTarget(),
      maxDirectBytes: 4,
      maxChunkBytes: 8
    })
    const codePointAt = vi.spyOn(String.prototype, 'codePointAt')
    const writePty = vi.fn<(data: string) => boolean>(() => false)

    const result = await executeTerminalPastePlan(plan, {
      pasteText: vi.fn(),
      writePty,
      isTargetCurrent: () => true
    })

    expect(result).toMatchObject({ status: 'cancelled', reason: 'target-disconnected' })
    expect(writePty).toHaveBeenCalledTimes(1)
    expect(writePty).toHaveBeenCalledWith('x'.repeat(8))
    expect(codePointAt.mock.calls.length).toBeLessThan(text.length)
  })

  it('cancels before writing when the target changed during async clipboard read', async () => {
    const pasteText = vi.fn()
    const writePty = vi.fn()
    const plan = planTerminalPaste({
      text: 'stale target',
      source: 'paste-event',
      target: terminalTarget()
    })

    const result = await executeTerminalPastePlan(plan, {
      pasteText,
      writePty,
      isTargetCurrent: () => false
    })

    expect(result).toMatchObject({ status: 'cancelled', reason: 'stale-target' })
    expect(pasteText).not.toHaveBeenCalled()
    expect(writePty).not.toHaveBeenCalled()
  })

  it('stops chunking when the PTY disconnects', async () => {
    let writable = true
    const writePty = vi.fn<(data: string) => boolean>(() => {
      writable = false
      return true
    })
    const plan = planTerminalPaste({
      text: '0123456789abcdef',
      source: 'middle-click',
      target: terminalTarget(),
      maxDirectBytes: 4,
      maxChunkBytes: 4
    })

    const result = await executeTerminalPastePlan(plan, {
      pasteText: vi.fn(),
      writePty,
      isTargetCurrent: () => true,
      canContinue: () => writable,
      yieldToEventLoop: async () => {}
    })

    expect(result).toMatchObject({ status: 'cancelled', reason: 'target-disconnected' })
    expect(writePty).toHaveBeenCalledTimes(1)
  })

  it('adds redacted execution outcome, reason, chunks, and duration to diagnostics', async () => {
    const secret = 'secret-token-123456'
    const plan = planTerminalPaste({
      text: secret,
      source: 'keyboard',
      target: terminalTarget(),
      maxDirectBytes: 4,
      maxChunkBytes: 4
    })
    const now = vi.fn()
    now.mockReturnValueOnce(10).mockReturnValueOnce(42)

    const result = await executeTerminalPastePlan(plan, {
      pasteText: vi.fn(),
      writePty: () => false,
      isTargetCurrent: () => true,
      canContinue: () => true,
      now
    })

    expect(result).toMatchObject({
      status: 'cancelled',
      reason: 'target-disconnected',
      chunksWritten: 0,
      durationMs: 32
    })
    expect(result.diagnostic).toContain('status=cancelled')
    expect(result.diagnostic).toContain('reason=target-disconnected')
    expect(result.diagnostic).toContain('chunks=0')
    expect(result.diagnostic).toContain('durationMs=32')
    expect(result.diagnostic).toContain('content=redacted')
    expect(result.diagnostic).not.toContain(secret)
  })

  it('redacts unsafe diagnostic reasons instead of echoing arbitrary text', () => {
    const secret = 'secret-token-from-exception'
    const plan = planTerminalPaste({
      text: 'safe payload',
      source: 'keyboard',
      target: terminalTarget()
    })

    const diagnostic = createRedactedPasteExecutionDiagnostic({
      chunksWritten: 0,
      durationMs: 7,
      plan,
      reason: `unexpected failure: ${secret}`,
      status: 'cancelled'
    })

    expect(diagnostic).toContain('status=cancelled')
    expect(diagnostic).toContain('reason=untrusted')
    expect(diagnostic).toContain('content=redacted')
    expect(diagnostic).not.toContain(secret)
    expect(diagnostic).not.toContain('unexpected failure')
  })

  it('cancels direct paste when the paste operation exceeds the safety timeout', async () => {
    vi.useFakeTimers()
    try {
      const plan = planTerminalPaste({
        text: 'small direct paste',
        source: 'keyboard',
        target: terminalTarget()
      })
      const pasteText = vi.fn(() => new Promise<void>(() => {}))

      const execution = executeTerminalPastePlan(plan, {
        pasteText,
        isTargetCurrent: () => true,
        operationTimeoutMs: 25
      })
      await vi.advanceTimersByTimeAsync(25)

      await expect(execution).resolves.toMatchObject({
        status: 'cancelled',
        reason: 'operation-timeout',
        chunksWritten: 0
      })
      expect(pasteText).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels chunked PTY paste when a write exceeds the safety timeout', async () => {
    vi.useFakeTimers()
    try {
      const plan = planTerminalPaste({
        text: '0123456789abcdef',
        source: 'keyboard',
        target: terminalTarget(),
        maxDirectBytes: 4,
        maxChunkBytes: 4
      })
      const writePty = vi.fn(() => new Promise<boolean>(() => {}))
      const yieldToEventLoop = vi.fn(async () => {})

      const execution = executeTerminalPastePlan(plan, {
        pasteText: vi.fn(),
        writePty,
        isTargetCurrent: () => true,
        canContinue: () => true,
        yieldToEventLoop,
        operationTimeoutMs: 25
      })
      await vi.advanceTimersByTimeAsync(25)

      await expect(execution).resolves.toMatchObject({
        status: 'cancelled',
        reason: 'operation-timeout',
        chunksWritten: 0
      })
      expect(writePty).toHaveBeenCalledTimes(1)
      expect(yieldToEventLoop).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops chunking when the target becomes stale between writes', async () => {
    let current = true
    const writePty = vi.fn<(data: string) => boolean>(() => true)
    const plan = planTerminalPaste({
      text: '0123456789abcdef',
      source: 'keyboard',
      target: terminalTarget(),
      maxDirectBytes: 4,
      maxChunkBytes: 4
    })

    const result = await executeTerminalPastePlan(plan, {
      pasteText: vi.fn(),
      writePty,
      isTargetCurrent: () => current,
      canContinue: () => true,
      yieldToEventLoop: async () => {
        current = false
      }
    })

    expect(result).toMatchObject({ status: 'cancelled', reason: 'stale-target' })
    expect(writePty).toHaveBeenCalledTimes(1)
  })

  it('closes an opened bracketed paste when stale focus cancels before payload chunks', async () => {
    let current = true
    const writePty = vi.fn<(data: string) => boolean>(() => true)
    const plan = planTerminalPaste({
      text: '0123456789abcdef',
      source: 'keyboard',
      target: terminalTarget(),
      terminalBracketedPasteMode: true,
      maxDirectBytes: 4,
      maxChunkBytes: 4
    })

    const result = await executeTerminalPastePlan(plan, {
      pasteText: vi.fn(),
      writePty,
      isTargetCurrent: () => current,
      canContinue: () => true,
      yieldToEventLoop: async () => {
        current = false
      }
    })

    expect(result).toMatchObject({ status: 'cancelled', reason: 'stale-target' })
    expect(writePty.mock.calls.map((call) => call[0])).toEqual([
      BRACKETED_PASTE_START,
      BRACKETED_PASTE_END
    ])
  })

  it('rejects oversized payloads before touching xterm or the PTY', async () => {
    const plan = planTerminalPaste({
      text: 'x'.repeat(12),
      source: 'programmatic',
      target: terminalTarget(),
      maxBytes: 8
    })
    const pasteText = vi.fn()
    const writePty = vi.fn()

    const result = await executeTerminalPastePlan(plan, {
      pasteText,
      writePty,
      isTargetCurrent: () => true
    })

    expect(plan.mode).toBe('reject')
    expect(result).toMatchObject({ status: 'rejected', reason: 'payload-too-large' })
    expect(pasteText).not.toHaveBeenCalled()
    expect(writePty).not.toHaveBeenCalled()
  })

  it('formats timeout cancellation without exposing pasted text', () => {
    expect(formatTerminalPasteExecutionError('operation-timeout')).toBe(
      'Paste cancelled: terminal did not accept paste before the safety timeout.'
    )
  })
})
