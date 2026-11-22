import { describe, expect, it } from 'vitest'
import {
  isCompleteAgentPromptDraft,
  isHeldAgentPromptDraft,
  iterateAgentPromptPasteChunks,
  openCodeCollapsesPaste
} from './agent-prompt-injection'

describe('agent prompt injection bytes', () => {
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
    ['the whole prompt', 'first line\r\nsecond line', 'first line\nsecond line', true],
    ['a prefix of it', 'first line\nsecond line', 'first line', false],
    [
      'the prompt with a newline moved, as a wrap shows it',
      'first line\nsecond line',
      'first line second\nline',
      false
    ],
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
    ["OpenCode's placeholder for its lines", '[Pasted ~143 lines]', true],
    ['an OpenCode paste of other lines', '[Pasted ~142 lines]', false],
    ['the user typing beside an OpenCode paste', '[Pasted ~143 lines] also fix the readme', false],
    ['a rotating placeholder', 'Explain this codebase', false]
  ])('%s -> %s', (_case, draft, held) => {
    expect(isHeldAgentPromptDraft(draft, prompt, 1)).toBe(held)
  })
})

// OpenCode v2.3.2 `pasteInputText`: `lineCount >= 3 || pastedContent.length > 150` on trimmed text.
describe('openCodeCollapsesPaste', () => {
  it.each([
    ['a one-line request', 'Fix the failing test.', false],
    ['two lines', 'Fix the failing test.\nThen run lint.', false],
    ['three lines', 'a\nb\nc', true],
    ['three lines with Windows line endings', 'a\r\nb\rc', true],
    ['150 chars', 'x'.repeat(150), false],
    ['151 chars', 'x'.repeat(151), true],
    ['150 chars inside surrounding whitespace', `\n\n  ${'x'.repeat(150)}  \n`, false]
  ])('%s -> %s', (_case, prompt, collapses) => {
    expect(openCodeCollapsesPaste(prompt)).toBe(collapses)
  })
})
