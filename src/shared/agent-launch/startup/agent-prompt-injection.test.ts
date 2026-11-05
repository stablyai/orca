import { describe, expect, it } from 'vitest'
import {
  AGENT_PROMPT_BRACKETED_PASTE_END,
  AGENT_PROMPT_BRACKETED_PASTE_START,
  buildAgentPromptPasteBytes,
  getAgentPromptSubmitDelayMs,
  getTerminalPasteIngestMs,
  isCompleteAgentPromptDraft,
  isHeldAgentPromptDraft,
  iterateAgentPromptPasteChunks
} from './agent-prompt-injection'

const BEGIN = AGENT_PROMPT_BRACKETED_PASTE_START
const END = AGENT_PROMPT_BRACKETED_PASTE_END

describe('agent prompt injection bytes', () => {
  it('types the lead line ahead of the paste frame on one line', () => {
    expect(buildAgentPromptPasteBytes('brief', 'Please\r\nfollow\x03\x1b[201~\x7f')).toBe(
      `Please follow [201~  ${BEGIN}brief${END}`
    )
    expect(buildAgentPromptPasteBytes('brief', '')).toBe(`${BEGIN}brief${END}`)
  })

  it.each([
    // Pin the slower measured Win11 ingest samples so Enter cannot race incomplete paste.
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

  it('sanitizes embedded escape bytes before framing', () => {
    const bytes = buildAgentPromptPasteBytes('before\x1b[201~after\x1b')
    expect(bytes).toBe(`${BEGIN}before<ESC>[201~after<ESC>${END}`)
    expect(bytes.slice(BEGIN.length, -END.length)).not.toContain('\x1b')
  })

  it('chunks a sanitized paste frame within the UTF-8 byte limit', () => {
    const body = 'a😀é'.repeat(200)
    const prompt = `header\n${body}\x1b[201~`
    const chunks = [...iterateAgentPromptPasteChunks(prompt, 31)]
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toBe(`\x1b[200~header\n${body}<ESC>[201~\x1b[201~`)
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, 'utf8')).toBeLessThanOrEqual(31)
      expect(Buffer.from(chunk, 'utf8').toString('utf8')).toBe(chunk)
    }
  })
})

describe('isCompleteAgentPromptDraft', () => {
  it.each([
    ['the whole prompt, wrapped', 'first line\nsecond line', 'first line second\nline', true],
    ['a prefix of it', 'first line\nsecond line', 'first line', false],
    ['a prompt whose trailing newline may not render', 'first line\n', 'first line', false]
  ])('%s', (_case, prompt, draft, complete) => {
    expect(isCompleteAgentPromptDraft(draft, prompt)).toBe(complete)
  })
})

describe('isHeldAgentPromptDraft', () => {
  // 142 LFs, as in the measured 10,312-char dispatch that Windows Codex showed as 10,597 chars.
  const prompt = Array.from({ length: 143 }, (_, line) => `${line}`.padEnd(71, 'x')).join('\n')

  it.each([
    ['the measured Windows count', `[Pasted Content ${prompt.length + 142 * 2 + 1} chars]`, true],
    [
      'a burst split into two placeholders',
      '[Pasted Content 4000 chars][Pasted Content 6312 chars] #2',
      true
    ],
    ['the prompt shown as text', prompt, true],
    ['its tail in a scrolled composer', prompt.slice(-200), true],
    ['a line from its middle', prompt.split('\n')[5], false],
    [
      'the user typing beside it',
      `[Pasted Content ${prompt.length} chars] also fix the readme`,
      false
    ],
    ['a larger unrelated paste', `[Pasted Content ${prompt.length * 2} chars]`, false],
    ['a shorter paste', `[Pasted Content ${prompt.length - 1} chars]`, false],
    ['a rotating placeholder', 'Explain this codebase', false]
  ])('%s -> %s', (_case, draft, held) => {
    expect(isHeldAgentPromptDraft(draft, prompt, 1)).toBe(held)
  })
})
