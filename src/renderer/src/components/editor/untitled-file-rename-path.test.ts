import { describe, expect, it } from 'vitest'
import {
  getUntitledFileRoot,
  isMarkdownUntitledName,
  isReservedRelativeName,
  resolveUntitledRenameFileName
} from './untitled-file-rename-path'

describe('isMarkdownUntitledName', () => {
  it('recognizes the markdown placeholder New Markdown creates', () => {
    expect(isMarkdownUntitledName('untitled.md')).toBe(true)
    expect(isMarkdownUntitledName('untitled-3.md')).toBe(true)
  })

  it('does not claim the extensionless placeholder New File creates', () => {
    expect(isMarkdownUntitledName('untitled')).toBe(false)
    expect(isMarkdownUntitledName('untitled-2')).toBe(false)
  })

  it('ignores extension case', () => {
    expect(isMarkdownUntitledName('untitled.MD')).toBe(true)
  })
})

describe('resolveUntitledRenameFileName', () => {
  it('keeps the .md suffix for an untitled markdown file', () => {
    expect(resolveUntitledRenameFileName('untitled.md', 'notes')).toBe('notes.md')
  })

  it('does not double the suffix when the user types it', () => {
    expect(resolveUntitledRenameFileName('untitled.md', 'notes.md')).toBe('notes.md')
    expect(resolveUntitledRenameFileName('untitled.md', 'notes.MD')).toBe('notes.md')
  })

  it('takes the typed name verbatim for an extensionless untitled file', () => {
    expect(resolveUntitledRenameFileName('untitled', 'main.go')).toBe('main.go')
  })

  it('never appends .md to a non-markdown untitled file', () => {
    // Why: this is the regression — a New File renamed to main.go became main.go.md,
    // which then opened in the rich markdown editor instead of the code editor.
    expect(resolveUntitledRenameFileName('untitled', 'main.go')).not.toContain('.md')
    expect(resolveUntitledRenameFileName('untitled-2', 'server.ts')).toBe('server.ts')
  })

  it('allows an extensionless result when that is what was typed', () => {
    expect(resolveUntitledRenameFileName('untitled', 'Makefile')).toBe('Makefile')
  })

  it('lets a generic untitled file become markdown if the user asks for it', () => {
    expect(resolveUntitledRenameFileName('untitled', 'readme.md')).toBe('readme.md')
  })

  it('trims surrounding whitespace', () => {
    expect(resolveUntitledRenameFileName('untitled.md', '  notes  ')).toBe('notes.md')
    expect(resolveUntitledRenameFileName('untitled', '  main.go  ')).toBe('main.go')
  })

  it('rejects dot-only names that would escape or re-target the folder', () => {
    // Why: these pass the separator check but join into the worktree root as `./` or `../`.
    // Before New File they were unreachable — a forced .md turned "." into "..md".
    expect(isReservedRelativeName(resolveUntitledRenameFileName('untitled', '.'))).toBe(true)
    expect(isReservedRelativeName(resolveUntitledRenameFileName('untitled', '..'))).toBe(true)
    expect(isReservedRelativeName(resolveUntitledRenameFileName('untitled', '  ..  '))).toBe(true)
  })

  it('does not reject ordinary dotfiles or names that merely contain dots', () => {
    expect(isReservedRelativeName(resolveUntitledRenameFileName('untitled', '.gitignore'))).toBe(
      false
    )
    expect(isReservedRelativeName(resolveUntitledRenameFileName('untitled', '...'))).toBe(false)
    expect(isReservedRelativeName(resolveUntitledRenameFileName('untitled', 'a.b'))).toBe(false)
  })

  it('returns an empty string when nothing usable was typed', () => {
    expect(resolveUntitledRenameFileName('untitled.md', '   ')).toBe('')
    expect(resolveUntitledRenameFileName('untitled', '')).toBe('')
    // A bare ".md" leaves no stem behind once the suffix is stripped.
    expect(resolveUntitledRenameFileName('untitled.md', '.md')).toBe('')
  })
})

describe('getUntitledFileRoot', () => {
  it('uses the real worktree path when one exists', () => {
    expect(
      getUntitledFileRoot(
        { filePath: '/tmp/floating/untitled.md', relativePath: 'untitled.md' },
        '/repo/worktree'
      )
    ).toBe('/repo/worktree')
  })

  it('falls back to the file root for floating markdown files', () => {
    expect(
      getUntitledFileRoot({
        filePath: '/Users/alice/Library/Application Support/Orca/floating-workspace/untitled.md',
        relativePath: 'untitled.md'
      })
    ).toBe('/Users/alice/Library/Application Support/Orca/floating-workspace')
  })

  it('handles nested untitled relative paths', () => {
    expect(
      getUntitledFileRoot({
        filePath: '/tmp/orca/floating-workspace/notes/untitled.md',
        relativePath: 'notes/untitled.md'
      })
    ).toBe('/tmp/orca/floating-workspace')
  })
})
