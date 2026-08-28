import { describe, expect, it, vi } from 'vitest'
import type { NativeChatBlock } from './native-chat-types'
import {
  briefToolArg,
  createToolInputDisplay,
  describeToolInput,
  formatToolInput,
  isStructuredToolInput,
  MAX_TOOL_DETAIL_LENGTH,
  summarizeToolInput,
  summarizeToolRun,
  toolFilePath,
  truncateToolDetail
} from './native-chat-tool-summary'

describe('createToolInputDisplay', () => {
  it('builds the shared row model from one JSON-string parse', () => {
    const parse = vi.spyOn(JSON, 'parse')
    const display = createToolInputDisplay(
      '{"file_path":"src/index.ts","description":"Read the entry point"}'
    )

    expect(display.label).toBe('src/index.ts')
    expect(display.filePath).toBe('src/index.ts')
    expect(display.hasDetail).toBe(true)
    expect(display.formatDetail()).toBe(
      '{\n  "file_path": "src/index.ts",\n  "description": "Read the entry point"\n}'
    )
    expect(parse).toHaveBeenCalledTimes(1)
    parse.mockRestore()
  })

  it('only offers detail when the formatted input adds information', () => {
    expect(createToolInputDisplay('x'.repeat(60)).hasDetail).toBe(false)
    expect(createToolInputDisplay('x'.repeat(100)).hasDetail).toBe(true)
    expect(createToolInputDisplay('{}').hasDetail).toBe(false)
    expect(createToolInputDisplay('{"command":"ls"}').hasDetail).toBe(true)
  })

  it('bounds tool detail through the shared desktop and mobile cap', () => {
    const detail = truncateToolDetail('x'.repeat(MAX_TOOL_DETAIL_LENGTH + 1))
    expect(detail).toHaveLength(MAX_TOOL_DETAIL_LENGTH + 1)
    expect(detail.endsWith('…')).toBe(true)
  })
})

describe('describeToolInput', () => {
  it('labels a file-target call with its path, not raw JSON', () => {
    expect(describeToolInput({ file_path: '/repo/src/app/Main.tsx', offset: 10 })).toBe(
      '/repo/src/app/Main.tsx'
    )
    expect(describeToolInput({ path: 'src/index.ts' })).toBe('src/index.ts')
    expect(describeToolInput({ file_path: 'C:\\Users\\me\\project\\app.tsx' })).toBe(
      'C:\\Users\\me\\project\\app.tsx'
    )
  })

  it('labels a command-shaped call with its primary argument', () => {
    expect(describeToolInput({ command: 'pnpm test', description: 'Run tests' })).toBe('pnpm test')
    expect(describeToolInput({ pattern: 'foo.*bar', glob: '*.ts' })).toBe('foo.*bar')
    expect(describeToolInput({ url: 'https://example.com', description: 'Fetch it' })).toBe(
      'https://example.com'
    )
    expect(describeToolInput({ description: 'Only prose' })).toBe('Only prose')
  })

  it('falls back to the bounded JSON preview for other shapes', () => {
    expect(describeToolInput({ todos: [{ id: 1 }] })).toBe(
      summarizeToolInput({ todos: [{ id: 1 }] })
    )
    expect(describeToolInput({ command: '   ' })).toBe(summarizeToolInput({ command: '   ' }))
    expect(describeToolInput('raw string input')).toBe('raw string input')
    expect(describeToolInput(null)).toBe('')
  })

  it('truncates an overlong path like any other preview', () => {
    const path = `/very/${'long/'.repeat(30)}file.ts`
    const label = describeToolInput({ file_path: path })
    expect(label.length).toBeLessThanOrEqual(80)
    expect(label).toContain('…')
    // A bounded JSON preview also satisfies the two assertions above, so pin the
    // label to the path itself or this passes with path-labelling deleted.
    expect(label).not.toContain('file_path')
    expect(label.endsWith('/file.ts')).toBe(true)
  })

  it('keeps the filename when trimming an overlong path', () => {
    // Head-truncating an absolute path drops the basename — the one part that
    // tells two rows apart — so the trim has to come off the front.
    const path = `/Users/me/orca/workspaces/orca/sta-3333/src/shared/${'nested/'.repeat(4)}app.tsx`
    const label = describeToolInput({ file_path: path, offset: 10 })
    expect(label.length).toBeLessThanOrEqual(80)
    expect(label.startsWith('…')).toBe(true)
    expect(label.endsWith('/app.tsx')).toBe(true)
  })

  it('distinguishes two long paths that share a deep prefix', () => {
    const base = '/Users/me/orca/workspaces/orca/sta-3333-tool-summary/src/session/native'
    const a = describeToolInput({ file_path: `${base}/MobileNativeChatMessage.tsx` })
    const b = describeToolInput({ file_path: `${base}/MobileNativeChatComposer.tsx` })
    expect(a).not.toBe(b)
  })

  it('names a search call by its pattern, not the directory it scanned', () => {
    // `path` on a Grep/Glob is the scan root; labelling with it loses the term.
    expect(describeToolInput({ pattern: 'summarizeToolInput', path: 'src/shared' })).toBe(
      'summarizeToolInput'
    )
    expect(describeToolInput({ pattern: '**/*.tsx', path: 'mobile/src' })).toBe('**/*.tsx')
    expect(describeToolInput({ query: 'auth flow', path: 'src' })).toBe('auth flow')
    // ...and offers no open-file link, since that path is a folder.
    expect(toolFilePath({ pattern: 'x', path: 'src/shared' })).toBeNull()
    expect(briefToolArg({ pattern: 'x', path: 'src/shared' })).toBe('x')
  })

  it('still treats an explicit file target as one alongside a search term', () => {
    expect(toolFilePath({ pattern: 'x', file_path: 'src/a.ts' })).toBe('src/a.ts')
    expect(toolFilePath({ path: 'src/c.ts' })).toBe('src/c.ts')
  })

  it('does not count a blank search key as a search', () => {
    // A whitespace-only `query` is no search term, but treating it as one
    // suppresses `path` — costing the row its label, its link and its header
    // argument all at once, and putting raw JSON back in the label.
    expect(toolFilePath({ query: '   ', path: 'src/a.ts' })).toBe('src/a.ts')
    expect(describeToolInput({ query: '   ', path: 'src/a.ts' })).toBe('src/a.ts')
    expect(briefToolArg({ query: '   ', path: 'src/a.ts' })).toBe('a.ts')
  })

  it('skips a present-but-blank key instead of falling through to raw JSON', () => {
    expect(describeToolInput({ command: '', query: 'needle' })).toBe('needle')
    expect(describeToolInput({ command: '   ', url: 'https://example.com' })).toBe(
      'https://example.com'
    )
    expect(briefToolArg({ cmd: '', query: 'needle' })).toBe('needle')
  })
})

describe('Codex JSON-string tool arguments', () => {
  it('normalizes them for labels, details, file links and run summaries', () => {
    expect(describeToolInput('{"cmd":"git status --short"}')).toBe('git status --short')
    expect(formatToolInput('{"cmd":"git status --short"}')).toBe(
      '{\n  "cmd": "git status --short"\n}'
    )
    expect(toolFilePath('{"file_path":"src/index.ts"}')).toBe('src/index.ts')
    expect(briefToolArg('{"file_path":"src/app/index.ts"}')).toBe('index.ts')
    expect(briefToolArg('{"cmd":"git status --short"}')).toBe('git status --short')
    expect(isStructuredToolInput('{"cmd":"ls"}')).toBe(true)
  })

  it('joins an argv-array command into one label', () => {
    expect(describeToolInput('{"command":["bash","-lc","make"]}')).toBe('bash -lc make')
    expect(briefToolArg({ command: ['bash', '-lc', 'make'] })).toBe('bash -lc make')
  })

  it('leaves prose and malformed JSON as plain strings', () => {
    expect(describeToolInput('{ not json')).toBe('{ not json')
    expect(formatToolInput('just prose')).toBe('just prose')
    expect(toolFilePath('{"file_path":')).toBeNull()
    expect(isStructuredToolInput('just prose')).toBe(false)
    // A JSON scalar is not an argument object — keep the literal text.
    expect(formatToolInput('"quoted"')).toBe('"quoted"')
  })
})

describe('isStructuredToolInput', () => {
  it('does not offer an expander whose detail would repeat the row label', () => {
    // `{}` formats back to `{}` — the label itself.
    expect(isStructuredToolInput({})).toBe(false)
    expect(isStructuredToolInput([])).toBe(false)
    expect(isStructuredToolInput('{}')).toBe(false)
    expect(isStructuredToolInput({ command: 'ls' })).toBe(true)
    expect(isStructuredToolInput([1])).toBe(true)
  })
})

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

  it('keeps a blank primary argument out of the run header', () => {
    // Skipping a blank key must not fall through to raw JSON — the row would
    // read `Bash {"command":""}` where it used to read `Bash`.
    expect(briefToolArg({ command: '' })).toBe('')
    expect(briefToolArg({ cmd: '   ' })).toBe('')
    expect(briefToolArg({ cmd: '', file_path: '' })).toBe('')
    const blocks: NativeChatBlock[] = [{ type: 'tool-call', name: 'Bash', input: { command: '' } }]
    expect(summarizeToolRun(blocks)).toBe('Bash')
  })

  it('still previews a primary argument that is populated but not a string', () => {
    // Only a *blank* key means "no argument" — a mixed argv or a structured
    // query is unrenderable as a label, not absent, so it keeps the preview.
    expect(briefToolArg({ command: ['kill', '-9', 1234] })).toBe('{"command":["kill","-9",1234')
    expect(briefToolArg({ command: 42 })).toBe('{"command":42}')
    expect(briefToolArg({ query: { text: 'auth flow' } })).toBe('{"query":{"text":"auth flow"')
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
