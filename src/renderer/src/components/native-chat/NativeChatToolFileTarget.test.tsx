// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeChatToolLine } from './NativeChatToolLine'
import { NativeChatDiffCard } from './NativeChatDiffCard'
import { createNativeChatFileHref } from '../../../../shared/native-chat-href-routing'
import type { NativeChatEditFile } from '../../../../shared/native-chat-edit-model'

afterEach(cleanup)

const editFile = (overrides: Partial<NativeChatEditFile>): NativeChatEditFile => ({
  path: 'src/main.ts',
  oldPath: null,
  changeKind: 'edited',
  lines: [{ kind: 'add', text: 'x', oldLineNumber: null, newLineNumber: 1 }],
  added: 1,
  removed: 0,
  lineNumbersKnown: true,
  truncated: false,
  ...overrides
})

describe('tool row file targets', () => {
  it('opens a read file in Orca without toggling the row', () => {
    const onLinkClick = vi.fn()
    render(
      <NativeChatToolLine
        block={{ type: 'tool-call', name: 'Read', input: { file_path: '/repo/src/main.ts' } }}
        result={{ type: 'tool-result', output: 'contents' }}
        onLinkClick={onLinkClick}
      />
    )
    const link = screen.getByRole('link', { name: '/repo/src/main.ts' })
    expect(link).toHaveTextContent('main.ts')
    fireEvent.click(link)
    expect(onLinkClick).toHaveBeenCalledWith(
      expect.anything(),
      createNativeChatFileHref('/repo/src/main.ts', 'literal')
    )
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('button')).toHaveAccessibleName(/Read.*\/repo\/src\/main.ts/)
  })

  it('opens from the keyboard', () => {
    const onLinkClick = vi.fn()
    render(
      <NativeChatToolLine
        block={{ type: 'tool-call', name: 'Write', input: { file_path: 'new.ts', content: 'a' } }}
        onLinkClick={onLinkClick}
      />
    )
    fireEvent.keyDown(screen.getByRole('link'), { key: 'Enter' })
    expect(onLinkClick).toHaveBeenCalledWith(
      expect.anything(),
      createNativeChatFileHref('new.ts', 'literal')
    )
  })

  it('leaves the name plain when the chat cannot open files, and for non-file tools', () => {
    render(
      <NativeChatToolLine
        block={{ type: 'tool-call', name: 'Read', input: { file_path: '/repo/src/main.ts' } }}
      />
    )
    expect(screen.queryByRole('link')).toBeNull()
    cleanup()
    render(
      <NativeChatToolLine
        block={{ type: 'tool-call', name: 'Grep', input: { pattern: 'TODO', path: '/repo' } }}
        onLinkClick={vi.fn()}
      />
    )
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('opens an edited file from its diff card without expanding the card', () => {
    const onLinkClick = vi.fn()
    render(<NativeChatDiffCard file={editFile({})} onLinkClick={onLinkClick} />)
    fireEvent.click(screen.getByRole('link', { name: 'src/main.ts' }))
    expect(onLinkClick).toHaveBeenCalledWith(
      expect.anything(),
      createNativeChatFileHref('src/main.ts', 'literal')
    )
    expect(screen.getByRole('button', { expanded: false })).toBeInTheDocument()
  })

  it('opens the new name of a renamed file, and nothing for a deleted one', () => {
    render(
      <NativeChatDiffCard
        file={editFile({ changeKind: 'renamed', oldPath: 'old.ts', path: 'new.ts' })}
        onLinkClick={vi.fn()}
      />
    )
    expect(screen.getAllByRole('link').map((link) => link.textContent)).toEqual(['new.ts'])
    cleanup()
    render(
      <NativeChatDiffCard
        file={editFile({ changeKind: 'deleted', lines: [] })}
        onLinkClick={vi.fn()}
      />
    )
    expect(screen.queryByRole('link')).toBeNull()
  })
})
