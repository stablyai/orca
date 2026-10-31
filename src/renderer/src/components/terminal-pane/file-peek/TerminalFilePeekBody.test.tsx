// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalFileContext } from '../terminal-file-path-mapping'
import type { TerminalFilePeekContent } from './terminal-file-peek-content-types'
import { TerminalFilePeekBody } from './TerminalFilePeekBody'

const readRuntimeFilePreview = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/use-highlighted-syntax', () => ({ useHighlightedSyntax: () => null }))
vi.mock('@/runtime/runtime-file-read-client', () => ({ readRuntimeFilePreview }))

afterEach(() => {
  cleanup()
  readRuntimeFilePreview.mockReset()
})

const FILE_CONTEXT: TerminalFileContext = {
  target: { kind: 'local' },
  worktreeId: 'worktree-1',
  worktreePath: '/repo',
  sourceHostResolved: true
}

function renderBody(
  content: TerminalFilePeekContent | 'loading',
  fileContext = FILE_CONTEXT
): HTMLElement {
  return render(<TerminalFilePeekBody content={content} fileContext={fileContext} />).container
}

function textContent(overrides: { targetLine: number | null; firstLineNumber: number }) {
  return {
    kind: 'text' as const,
    path: '/repo/src/index.ts',
    language: 'typescript',
    lines: ['const a = 1', 'const b = 2', 'const c = 3'],
    truncatedLines: false,
    ...overrides
  }
}

describe('TerminalFilePeekBody', () => {
  it('numbers excerpt lines from the first line and marks only the referenced one', () => {
    const container = renderBody(textContent({ firstLineNumber: 40, targetLine: 41 }))

    expect(screen.getByText('40')).toBeTruthy()
    expect(screen.getByText('42')).toBeTruthy()
    expect(container.querySelectorAll('[data-current="true"]')).toHaveLength(1)
    expect(screen.getByText('41').className).toContain('text-foreground')
    expect(screen.getByText('40').className).not.toContain('text-foreground')
  })

  it.each([
    ['no referenced line', null],
    ['a referenced line outside the excerpt', 99]
  ])('marks no row for %s', (_name, targetLine) => {
    const container = renderBody(textContent({ firstLineNumber: 1, targetLine }))

    expect(container.querySelector('[data-current]')).toBeNull()
  })

  it('notes when long lines were cut off', () => {
    renderBody({ ...textContent({ firstLineNumber: 1, targetLine: null }), truncatedLines: true })

    expect(screen.getByText('Long lines are cut off.')).toBeTruthy()
  })

  it.each([
    ['binary', 'Binary file, no preview.'],
    ['too-large', 'This file is too large to preview.'],
    ['line-out-of-range', 'The referenced line is past the end of the file.'],
    ['unreadable', "This file can't be read."],
    ['unsupported', 'No preview for this kind of file.']
  ] as const)('says why a %s file has no preview', (reason, sentence) => {
    renderBody({ kind: 'notice', path: '/repo/file', reason })

    expect(screen.getByText(sentence)).toBeTruthy()
  })

  it('lists directory entries in the given order with a more-entries notice', () => {
    const container = renderBody({
      kind: 'directory',
      path: '/repo',
      entries: [
        { name: 'src', isDirectory: true, isSymlink: false },
        { name: 'link.md', isDirectory: false, isSymlink: true },
        { name: 'a.ts', isDirectory: false, isSymlink: false }
      ],
      hasMore: true
    })

    expect([...container.querySelectorAll('li')].map((row) => row.textContent)).toEqual([
      'src',
      'link.mdSymbolic link',
      'a.ts'
    ])
    expect(screen.getByText('More entries are not shown.')).toBeTruthy()
  })

  it('says an empty directory is empty and omits the more-entries notice', () => {
    renderBody({ kind: 'directory', path: '/repo', entries: [], hasMore: false })

    expect(screen.getByText('This folder is empty.')).toBeTruthy()
    expect(screen.queryByText('More entries are not shown.')).toBeNull()
  })

  it('announces loading as a labelled status', () => {
    renderBody('loading')

    expect(screen.getByRole('status', { name: 'Loading preview' })).toBeTruthy()
  })

  it('reads an image through its resolved owner', () => {
    readRuntimeFilePreview.mockRejectedValue(new Error('unavailable'))

    renderBody({ kind: 'image', path: '/repo/logo.png', sizeBytes: 2048 })

    expect(readRuntimeFilePreview).toHaveBeenCalledTimes(1)
    expect(readRuntimeFilePreview.mock.calls[0]?.[0]).toMatchObject(FILE_CONTEXT)
  })

  it('does not read an image whose owner is unresolved', () => {
    const container = renderBody(
      { kind: 'image', path: '/repo/logo.png', sizeBytes: 2048 },
      { ...FILE_CONTEXT, sourceHostResolved: false }
    )

    expect(readRuntimeFilePreview).not.toHaveBeenCalled()
    expect(container.querySelectorAll('img')).toHaveLength(0)
    expect(screen.getByText("This file can't be read.")).toBeTruthy()
  })
})
