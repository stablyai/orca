import { describe, expect, it } from 'vitest'
import {
  AGENT_PROMPT_BRACKETED_PASTE_END,
  AGENT_PROMPT_BRACKETED_PASTE_START,
  buildAgentPromptPasteBytes,
  buildAgentPromptSubmitBytes,
  getAgentPromptSubmitDelayMs,
  getMaxTerminalPasteBytesForIngestMs,
  getTerminalPasteIngestMs,
  iterateAgentPromptPasteChunks,
  sanitizeAgentPromptText
} from './agent-prompt-injection'

const BEGIN = AGENT_PROMPT_BRACKETED_PASTE_START
const END = AGENT_PROMPT_BRACKETED_PASTE_END

describe('agent prompt injection bytes', () => {
  it('always bracket-pastes prompts so agent TUIs treat newlines as content', () => {
    expect(buildAgentPromptPasteBytes('line one\nline two')).toBe(
      `${BEGIN}line one\nline two${END}`
    )
  })

  it('keeps submit separate from the paste frame', () => {
    expect(buildAgentPromptPasteBytes('hello')).not.toContain('\r')
    expect(buildAgentPromptSubmitBytes()).toBe('\r')
  })

  it('costs a common-sized prompt far less than the old flat Windows delay', () => {
    // Measured ingest: 2 KB 14-25 ms, 8 KB 60-89 ms. The old constant charged 1_500 ms for both.
    expect(getAgentPromptSubmitDelayMs('win32', 2_000)).toBeLessThan(700)
    expect(getAgentPromptSubmitDelayMs('win32', 8_000)).toBeLessThan(700)
    expect(getAgentPromptSubmitDelayMs('darwin', 8_000)).toBeLessThan(700)
  })

  it.each([
    // The slower of the two measured Win11 hosts at each size. Dipping under any of these
    // reopens the mid-paste Enter bug, so pin all of them, not just the top end.
    [2_000, 25],
    [8_000, 89],
    [40_000, 440],
    [80_000, 858],
    [160_000, 1_662],
    [320_000, 3_342]
  ])('outlasts the slowest measured ConPTY ingest of %i bytes', (bytes, measuredMs) => {
    expect(getTerminalPasteIngestMs('win32', bytes)).toBeGreaterThan(measuredMs)
    expect(getAgentPromptSubmitDelayMs('win32', bytes)).toBeGreaterThan(measuredMs)
  })

  it('keeps a real margin over the slowest measured slope', () => {
    // 1.5x of 0.0104 ms/byte, so a host ~50% slower than either measured one is still covered.
    expect(getTerminalPasteIngestMs('win32', 320_000)).toBeGreaterThan(3_342 * 1.4)
  })

  it('outgrows the old 1_500 ms constant before ConPTY ingest does', () => {
    // Ingest crossed 1_500 ms at ~145 KB; the delay must already exceed it there.
    expect(getAgentPromptSubmitDelayMs('win32', 145_000)).toBeGreaterThan(1_500)
  })

  it('scales without a cap all the way to the terminal input ceiling', () => {
    const ceilingBytes = 16 * 1024 * 1024
    expect(getAgentPromptSubmitDelayMs('win32', ceilingBytes)).toBeGreaterThan(250_000)
    // Even the fast platforms outrun a flat 500 ms at the ceiling.
    expect(getAgentPromptSubmitDelayMs('linux', ceilingBytes)).toBeGreaterThan(4_000)
  })

  it('charges non-Windows hosts nothing measurable for a real prompt', () => {
    expect(getTerminalPasteIngestMs('darwin', 8_000)).toBeLessThanOrEqual(2)
    expect(getTerminalPasteIngestMs('linux', 0)).toBe(0)
    expect(getTerminalPasteIngestMs('linux', Number.NaN)).toBe(0)
    expect(getTerminalPasteIngestMs('win32', -5)).toBe(0)
  })

  it('grows monotonically with payload size on every platform', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(getAgentPromptSubmitDelayMs(platform, 400_000)).toBeGreaterThan(
        getAgentPromptSubmitDelayMs(platform, 40_000)
      )
    }
    expect(getTerminalPasteIngestMs('win32', 320_000)).toBeGreaterThan(
      getTerminalPasteIngestMs('darwin', 320_000)
    )
  })

  it('inverts the host ingest budget without crossing it', () => {
    const bytes = getMaxTerminalPasteBytesForIngestMs('win32', 20_000)
    expect(getTerminalPasteIngestMs('win32', bytes)).toBe(20_000)
    expect(getTerminalPasteIngestMs('win32', bytes + 1)).toBe(20_001)
  })

  it('sanitizes embedded escape bytes before framing', () => {
    const bytes = buildAgentPromptPasteBytes('before\x1b[201~after\x1b')
    expect(bytes).toBe(`${BEGIN}before<ESC>[201~after<ESC>${END}`)
    expect(bytes.slice(BEGIN.length, -END.length)).not.toContain('\x1b')
  })

  it('exposes the sanitizer for tests and diagnostics', () => {
    expect(sanitizeAgentPromptText('a\x1bb')).toBe('a<ESC>b')
  })

  it('chunks without changing the reconstructed paste frame', () => {
    const prompt = `header\n${'abc123'.repeat(200)}`
    const chunks = [...iterateAgentPromptPasteChunks(prompt, 31)]
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toBe(buildAgentPromptPasteBytes(prompt))
    expect(chunks.join('')).toContain(`${BEGIN}header\n`)
    expect(chunks.join('')).toContain(END)
  })
})
