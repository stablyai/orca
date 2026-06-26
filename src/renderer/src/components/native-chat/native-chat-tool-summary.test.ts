import { describe, it, expect } from 'vitest'
import type { NativeChatBlock } from '../../../../shared/native-chat-types'
import {
  briefToolArg,
  countToolCalls,
  summarizeToolInput,
  summarizeToolRun
} from './native-chat-tool-summary'

describe('summarizeToolInput', () => {
  it('passes short strings through and collapses whitespace', () => {
    expect(summarizeToolInput('  hello   world ')).toBe('hello world')
  })

  it('serializes objects to compact JSON', () => {
    expect(summarizeToolInput({ a: 1 })).toBe('{"a":1}')
  })

  it('truncates long previews with an ellipsis', () => {
    const long = 'x'.repeat(200)
    const out = summarizeToolInput(long)
    expect(out.endsWith('…')).toBe(true)
    expect(out.length).toBe(80)
  })

  it('returns empty for null/undefined', () => {
    expect(summarizeToolInput(null)).toBe('')
    expect(summarizeToolInput(undefined)).toBe('')
  })
})

describe('briefToolArg', () => {
  it('uses the file basename when present', () => {
    expect(briefToolArg({ file_path: '/a/b/app.tsx' })).toBe('app.tsx')
  })

  it('falls back to a clipped command', () => {
    expect(briefToolArg({ command: 'git status --short' })).toBe('git status --short')
  })
})

describe('summarizeToolRun', () => {
  it('joins tool-call names with their brief arg', () => {
    const blocks: NativeChatBlock[] = [
      { type: 'tool-call', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool-result', output: 'x' },
      { type: 'tool-call', name: 'Edit', input: { file_path: '/x/app.tsx' } }
    ]
    expect(summarizeToolRun(blocks)).toBe('Bash ls  ·  Edit app.tsx')
  })

  it('skips nameless tool calls so the join has no orphan separators', () => {
    const blocks: NativeChatBlock[] = [
      { type: 'tool-call', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool-call', name: '   ', input: { command: 'x' } },
      { type: 'tool-call', name: 'Edit', input: { file_path: '/x/app.tsx' } }
    ]
    expect(summarizeToolRun(blocks)).toBe('Bash ls  ·  Edit app.tsx')
  })
})

describe('countToolCalls', () => {
  it('counts only tool-call blocks', () => {
    const blocks: NativeChatBlock[] = [
      { type: 'tool-call', name: 'Bash', input: {} },
      { type: 'tool-result', output: 'x' },
      { type: 'tool-call', name: 'Read', input: {} }
    ]
    expect(countToolCalls(blocks)).toBe(2)
  })
})
