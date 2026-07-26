import { describe, expect, it } from 'vitest'
import {
  AGENT_PROMPT_BRACKETED_PASTE_END,
  AGENT_PROMPT_BRACKETED_PASTE_START,
  buildAgentPromptPasteBytes,
  buildAgentPromptSubmitBytes,
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
