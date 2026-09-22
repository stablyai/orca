import { describe, expect, it } from 'vitest'
import {
  formatNativeChatToolRunSentence,
  nativeChatToolRunClauses
} from './native-chat-tool-run-sentence'

const read = { name: 'read' }
const shell = { name: 'shell' }
const search = { name: 'search' }
const edit = { name: 'Edit' }

describe('nativeChatToolRunClauses', () => {
  it('counts each category once, in the order the run first used it', () => {
    expect(nativeChatToolRunClauses([shell, read, shell, search, read, read])).toEqual([
      { category: 'unknown', count: 2 },
      { category: 'read', count: 3 },
      { category: 'search', count: 1 }
    ])
  })

  it('files a tool the vocabulary does not model under the generic category', () => {
    expect(nativeChatToolRunClauses([{ name: 'tools/read' }])).toEqual([
      { category: 'other', count: 1 }
    ])
  })

  it('reads an MCP call by its prefix rather than its tool name', () => {
    expect(nativeChatToolRunClauses([{ name: 'mcp__linear__list_issues' }])).toEqual([
      { category: 'mcpToolCall', count: 1 }
    ])
  })
})

describe('formatNativeChatToolRunSentence', () => {
  it('renders one clause on its own', () => {
    expect(formatNativeChatToolRunSentence([shell, shell])).toBe('Ran 2 commands')
  })

  it('joins two clauses with "and" and no comma', () => {
    expect(formatNativeChatToolRunSentence([shell, shell, read])).toBe(
      'Ran 2 commands and read 1 file'
    )
  })

  it('joins three or more with commas and a final "and"', () => {
    expect(formatNativeChatToolRunSentence([read, read, shell, search, edit])).toBe(
      'Read 2 files, ran 1 command, searched 1 time, and edited 1 file'
    )
  })

  it('capitalizes only the first clause, so the rest continue the sentence', () => {
    expect(formatNativeChatToolRunSentence([read, shell])).toBe('Read 1 file and ran 1 command')
  })

  it('uses the singular form for a count of one', () => {
    expect(formatNativeChatToolRunSentence([read])).toBe('Read 1 file')
    expect(formatNativeChatToolRunSentence([search])).toBe('Searched 1 time')
  })

  it('renders nothing for a run with no calls', () => {
    expect(formatNativeChatToolRunSentence([])).toBe('')
  })
})
