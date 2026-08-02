import { describe, expect, it, vi } from 'vitest'
import { Button } from '@/components/ui/button'
import { FileResultRow } from './SearchResultItems'
import type { SearchFileResult } from '../../../../shared/types'

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

function visit(node: unknown, cb: (node: ReactElementLike) => void): void {
  if (node == null || typeof node === 'string' || typeof node === 'number') {
    return
  }
  if (Array.isArray(node)) {
    node.forEach((entry) => visit(entry, cb))
    return
  }
  const element = node as ReactElementLike
  cb(element)
  if (element.props?.children) {
    visit(element.props.children, cb)
  }
}

function findFileRowButton(node: unknown): ReactElementLike {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (entry.type === Button && entry.props.onClick) {
      found = entry
    }
  })
  if (!found) {
    throw new Error('file row button not found')
  }
  return found
}

function findBadgeText(node: unknown): string {
  let text = ''
  visit(node, (entry) => {
    if (
      typeof entry.type === 'string' &&
      entry.type === 'span' &&
      typeof entry.props.className === 'string' &&
      entry.props.className.includes('rounded-full')
    ) {
      text = String(entry.props.children)
    }
  })
  return text
}

const match = { line: 1, column: 1, matchLength: 3, lineContent: 'foo' }

function makeFile(overrides: Partial<SearchFileResult> = {}): SearchFileResult {
  return {
    filePath: '/repo/a.ts',
    relativePath: 'src/a.ts',
    matches: [match, match],
    ...overrides
  }
}

function renderFileResultRow(fileResult: SearchFileResult): ReactElementLike {
  return FileResultRow({
    fileResult,
    collapsed: false,
    onToggleCollapse: vi.fn()
  }) as unknown as ReactElementLike
}

describe('FileResultRow', () => {
  it('renders omitted matchCount as the navigable match count', () => {
    expect(findBadgeText(findFileRowButton(renderFileResultRow(makeFile())))).toBe('2')
  })

  it('repairs bogus too-low matchCount values', () => {
    expect(findBadgeText(findFileRowButton(renderFileResultRow(makeFile({ matchCount: 0 }))))).toBe(
      '2'
    )
  })

  it('renders matchCount when it is greater than preview rows', () => {
    expect(findBadgeText(findFileRowButton(renderFileResultRow(makeFile({ matchCount: 7 }))))).toBe(
      '7'
    )
  })
})
