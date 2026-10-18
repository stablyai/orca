import { describe, expect, it } from 'vitest'
import {
  NATIVE_CHAT_TOOL_RUN_SENTENCE_ENGLISH,
  nativeChatToolRunClauses,
  nativeChatToolRunSentence
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

function english(calls: { name: string; input?: unknown }[], live = false): string | null {
  return nativeChatToolRunSentence(
    calls.map((call) => ({ type: 'tool-call', name: call.name, input: call.input ?? {} })),
    { live },
    NATIVE_CHAT_TOOL_RUN_SENTENCE_ENGLISH
  )
}

describe('nativeChatToolRunSentence in English', () => {
  it('renders one clause on its own', () => {
    expect(english([shell, shell])).toBe('Ran 2 commands')
  })

  it('joins two clauses with "and" and no comma', () => {
    expect(english([shell, shell, read])).toBe('Ran 2 commands and read 1 file')
  })

  it('joins three or more with commas and a final "and"', () => {
    expect(english([read, read, shell, search, edit])).toBe(
      'Read 2 files, ran 1 command, searched 1 time, and edited 1 file'
    )
  })

  it('capitalizes only the first clause, so the rest continue the sentence', () => {
    expect(english([read, shell])).toBe('Read 1 file and ran 1 command')
  })

  it('uses the singular form for a count of one', () => {
    expect(english([read])).toBe('Read 1 file')
    expect(english([search])).toBe('Searched 1 time')
  })

  it('names a lone settled command by the command itself, but not while live', () => {
    const push = { name: 'Bash', input: { command: 'git push' } }
    expect(english([push])).toBe('git push')
    expect(english([push], true)).toBe('Running 1 command')
  })

  it('speaks in the present tense while live', () => {
    expect(english([read, read, shell], true)).toBe('Reading 2 files and running 1 command')
  })

  it("counts Claude's Agent alias as a subagent", () => {
    expect(english([{ name: 'Agent' }, { name: 'Task' }])).toBe('Ran 2 agents')
  })

  it('renders nothing for a run with no calls', () => {
    expect(english([])).toBeNull()
  })
})
