import { describe, expect, it } from 'vitest'
import {
  isShellActivityToolCall,
  NATIVE_CHAT_TOOL_ICON_NAMES,
  nativeChatToolCategory,
  nativeChatToolIconName,
  nativeChatToolRunCategory,
  nativeChatToolRunIconName,
  type NativeChatToolCategory
} from './native-chat-tool-icon'

const ALL_CATEGORIES: NativeChatToolCategory[] = [
  'read',
  'search',
  'listFiles',
  'unknown',
  'fileChange',
  'webSearch',
  'mcpToolCall',
  'subAgentActivity',
  'todoList',
  'other'
]

describe('native chat tool icons', () => {
  it('names a glyph for every category in the vocabulary', () => {
    expect(NATIVE_CHAT_TOOL_ICON_NAMES).toEqual({
      read: 'eye',
      search: 'search',
      listFiles: 'folder',
      unknown: 'square-terminal',
      fileChange: 'pencil',
      webSearch: 'globe',
      mcpToolCall: 'plug',
      subAgentActivity: 'bot',
      todoList: 'list-checks',
      other: 'wrench'
    })
    expect(Object.keys(NATIVE_CHAT_TOOL_ICON_NAMES).sort()).toEqual([...ALL_CATEGORIES].sort())
  })

  it('gives each category a distinct glyph so rows are told apart by icon', () => {
    const glyphs = ALL_CATEGORIES.map((category) => NATIVE_CHAT_TOOL_ICON_NAMES[category])
    expect(new Set(glyphs).size).toBe(glyphs.length)
  })

  it('maps the row words the Codex lane renders to their category', () => {
    expect(nativeChatToolCategory('read')).toBe('read')
    expect(nativeChatToolCategory('search')).toBe('search')
    expect(nativeChatToolCategory('list')).toBe('listFiles')
    expect(nativeChatToolCategory('shell')).toBe('unknown')
    expect(nativeChatToolCategory('apply_patch')).toBe('fileChange')
    expect(nativeChatToolCategory('web search')).toBe('webSearch')
  })

  it('maps the tool names the Claude lane renders verbatim', () => {
    expect(nativeChatToolIconName('Read')).toBe('eye')
    expect(nativeChatToolIconName('Bash')).toBe('square-terminal')
    expect(nativeChatToolIconName('Grep')).toBe('search')
    expect(nativeChatToolIconName('Glob')).toBe('search')
    expect(nativeChatToolIconName('Task')).toBe('bot')
    expect(nativeChatToolIconName('WebFetch')).toBe('globe')
    expect(nativeChatToolIconName('TodoWrite')).toBe('list-checks')
  })

  it('reads the whole edit family from the shared set, not a parallel list', () => {
    for (const name of ['Edit', 'MultiEdit', 'Write', 'str_replace', 'apply_patch']) {
      expect(nativeChatToolCategory(name)).toBe('fileChange')
      expect(nativeChatToolIconName(name)).toBe('pencil')
    }
  })

  it('reads the projected `Diff` row as a file change, which is what it renders', () => {
    // Every Codex fileChange item projects to a call named `Diff`, so a wrench
    // here headed a run whose body is an edited-file card.
    expect(nativeChatToolCategory('Diff')).toBe('fileChange')
    expect(nativeChatToolIconName('Diff')).toBe('pencil')
  })

  it('reads an MCP tool by its prefix, since the row is named after the tool', () => {
    expect(nativeChatToolCategory('mcp__linear__create_issue')).toBe('mcpToolCall')
    expect(nativeChatToolIconName('mcp__playwright__browser_click')).toBe('plug')
    // Not a prefix match: a tool merely mentioning mcp is not an MCP call.
    expect(nativeChatToolCategory('run_mcp__thing')).toBeNull()
  })

  it('resolves the glyph for each classified row word', () => {
    expect(nativeChatToolIconName('read')).toBe('eye')
    expect(nativeChatToolIconName('search')).toBe('search')
    expect(nativeChatToolIconName('list')).toBe('folder')
    expect(nativeChatToolIconName('shell')).toBe('square-terminal')
    expect(nativeChatToolIconName('edit')).toBe('pencil')
    expect(nativeChatToolIconName('web search')).toBe('globe')
  })

  it('reads a row word regardless of case or surrounding space', () => {
    expect(nativeChatToolIconName('  Read ')).toBe('eye')
    expect(nativeChatToolIconName('WebSearch')).toBe('globe')
  })

  it('falls back to the generic tool glyph, not the terminal, outside the vocabulary', () => {
    // Claiming a terminal here would assert a shell ran when nothing says one did.
    expect(nativeChatToolCategory('AskUserQuestion')).toBeNull()
    expect(nativeChatToolIconName('AskUserQuestion')).toBe('wrench')
    expect(nativeChatToolIconName('')).toBe('wrench')
  })

  it('keeps the terminal glyph for a row that really ran a command', () => {
    // `exec` and `local_shell` are how the Codex rollout transcript names a
    // shell call; `native-chat-edit-normalize` already calls the three command
    // tools by those words, so a wrench on one would deny a command that ran.
    for (const name of ['shell', 'bash', 'run_terminal_cmd', 'exec', 'local_shell']) {
      expect(nativeChatToolCategory(name)).toBe('unknown')
      expect(nativeChatToolIconName(name)).toBe('square-terminal')
    }
  })

  describe('terminal activity for a two-glyph lane', () => {
    // Mobile has only a terminal and a wrench, so it asks this instead of
    // `nativeChatToolIconName`. The row word alone cannot answer it: Codex's
    // classified `read` and Claude's `Read` are the same word lowercased.

    it('reads a classified Codex row as terminal activity, by the command it kept', () => {
      for (const [name, fields] of [
        ['read', { path: 'src/app.ts' }],
        ['search', { query: 'todo', directory: 'src' }],
        ['list', { directory: 'src' }]
      ] as const) {
        expect(
          isShellActivityToolCall({
            name,
            input: { command: 'rg todo src', cwd: '/repo', ...fields }
          })
        ).toBe(true)
      }
    })

    it('reads an unclassified shell row as terminal activity, by its name', () => {
      for (const name of ['shell', 'bash', 'Bash', 'run_terminal_cmd']) {
        expect(isShellActivityToolCall({ name, input: null })).toBe(true)
      }
    })

    it('reads a rollout-transcript shell call as terminal activity', () => {
      // `exec` and `local_shell` are not command tool names, so only the argv
      // command in their input says a shell ran.
      expect(
        isShellActivityToolCall({ name: 'exec', input: '{"command":["bash","-lc","ls"]}' })
      ).toBe(true)
      expect(
        isShellActivityToolCall({ name: 'local_shell', input: { command: ['bash', '-lc', 'ls'] } })
      ).toBe(true)
    })

    it('leaves a Claude filesystem tool a generic tool, since no command ran', () => {
      expect(
        isShellActivityToolCall({ name: 'Read', input: { file_path: '/repo/src/app.ts' } })
      ).toBe(false)
      expect(
        isShellActivityToolCall({ name: 'Grep', input: { pattern: 'todo', path: 'src' } })
      ).toBe(false)
      expect(isShellActivityToolCall({ name: 'Glob', input: { pattern: '**/*.ts' } })).toBe(false)
    })

    it('leaves an unmodelled tool a generic tool', () => {
      expect(
        isShellActivityToolCall({ name: 'AskUserQuestion', input: { question: 'which?' } })
      ).toBe(false)
      for (const name of ['Edit', 'Diff', 'Task', 'WebFetch', 'TodoWrite', '']) {
        expect(isShellActivityToolCall({ name, input: { file_path: 'a.ts' } })).toBe(false)
      }
    })

    it('answers false for an input that carries no command, whatever its shape', () => {
      for (const input of [
        null,
        undefined,
        'ls -la',
        42,
        ['bash', '-lc', 'ls'],
        {},
        { cwd: '/r' }
      ]) {
        expect(isShellActivityToolCall({ name: 'read', input })).toBe(false)
      }
      // A present-but-blank command is not a command that ran.
      expect(isShellActivityToolCall({ name: 'read', input: { command: '   ' } })).toBe(false)
      expect(isShellActivityToolCall({ name: 'read', input: { command: null } })).toBe(false)
    })
  })

  describe('the glyph over a whole run', () => {
    // A run header stands over a summary of the run's first calls, so its glyph
    // may only claim a category every call in the run shares.

    it('keeps the category when every call in the run is of it', () => {
      const run = [{ name: 'Read' }, { name: 'read' }, { name: '  Read  ' }]

      expect(nativeChatToolRunCategory(run)).toBe('read')
      expect(nativeChatToolRunIconName(run)).toBe('eye')
    })

    it('reads a run of differently-named shell calls as one shell run', () => {
      // The categories agree even though the words do not, so the run is still
      // one thing and keeps the terminal.
      const run = [{ name: 'shell' }, { name: 'Bash' }, { name: 'local_shell' }]

      expect(nativeChatToolRunCategory(run)).toBe('unknown')
      expect(nativeChatToolRunIconName(run)).toBe('square-terminal')
    })

    it('falls back to the generic tool glyph when the run spans categories', () => {
      const run = [{ name: 'shell' }, { name: 'Read' }]

      expect(nativeChatToolRunCategory(run)).toBeNull()
      // Either category here would describe only part of the run.
      expect(nativeChatToolRunIconName(run)).toBe('wrench')
      // Order does not make one call speak for the rest.
      expect(nativeChatToolRunIconName([{ name: 'Read' }, { name: 'shell' }])).toBe('wrench')
    })

    it('takes a single call at its own category', () => {
      expect(nativeChatToolRunCategory([{ name: 'Grep' }])).toBe('search')
      expect(nativeChatToolRunIconName([{ name: 'Grep' }])).toBe('search')
      expect(nativeChatToolRunIconName([{ name: 'apply_patch' }])).toBe('pencil')
    })

    it('reads a run of unmodelled tools as the generic category, not as spanning', () => {
      const run = [{ name: 'AskUserQuestion' }, { name: 'SomeOtherTool' }]

      expect(nativeChatToolRunCategory(run)).toBe('other')
      expect(nativeChatToolRunIconName(run)).toBe('wrench')
    })

    it('has no glyph to give a run with no tool calls', () => {
      expect(nativeChatToolRunCategory([])).toBeNull()
      // Null, not a wrench: an empty header shows no glyph rather than a false one.
      expect(nativeChatToolRunIconName([])).toBeNull()
    })
  })

  it('does not answer a prototype key with a glyph', () => {
    expect(nativeChatToolCategory('__proto__')).toBeNull()
    expect(nativeChatToolCategory('constructor')).toBeNull()
    expect(nativeChatToolIconName('__proto__')).toBe('wrench')
  })
})
