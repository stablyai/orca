import { describe, expect, it } from 'vitest'
import type { NativeChatBlock } from './native-chat-types'
import { briefToolArg, summarizeToolInput, summarizeToolRun } from './native-chat-tool-summary'

describe('summarizeToolInput bounded preview', () => {
  it('collapses depth beyond the bound instead of serializing the whole tree', () => {
    const deep = { a: { b: { c: { d: 'buried' } } } }
    const preview = summarizeToolInput(deep)
    expect(preview).toContain('[…]')
    expect(preview).not.toContain('buried')
  })

  it('truncates oversized collections with an ellipsis marker', () => {
    const wide = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, i]))
    const preview = summarizeToolInput(wide)
    expect(preview).toContain('…')
    expect(preview).not.toContain('k11')
  })

  it('survives circular references', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' }
    cyclic.self = cyclic
    expect(summarizeToolInput(cyclic)).toContain('[circular]')
  })
})

describe('briefToolArg', () => {
  it('extracts the basename from forward- and backslash paths', () => {
    expect(briefToolArg({ file_path: 'src/app/main.tsx' })).toBe('main.tsx')
    expect(briefToolArg({ file_path: 'C:\\Users\\me\\project\\app.tsx' })).toBe('app.tsx')
  })

  it('falls back to the command preview when no path is present', () => {
    expect(briefToolArg({ command: 'git status --short' })).toBe('git status --short')
  })
})

describe('summarizeToolRun', () => {
  it('caps the run summary and skips nameless calls', () => {
    const blocks: NativeChatBlock[] = [
      { type: 'tool-call', name: '  ', input: {} },
      { type: 'tool-call', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool-call', name: 'Read', input: { file_path: 'a.ts' } },
      { type: 'tool-call', name: 'Edit', input: { file_path: 'b.ts' } },
      { type: 'tool-call', name: 'Write', input: { file_path: 'c.ts' } }
    ]
    const summary = summarizeToolRun(blocks)
    expect(summary).toBe('Bash ls  ·  Read a.ts  ·  Edit b.ts')
  })
})
