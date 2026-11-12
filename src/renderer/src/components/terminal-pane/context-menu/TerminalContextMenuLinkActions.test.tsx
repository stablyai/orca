// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalContextMenuLinkActions } from './TerminalContextMenuLinkActions'

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuItem: ({
    children,
    onSelect
  }: {
    children: React.ReactNode
    onSelect?: () => void
  }) => (
    <button type="button" onClick={() => onSelect?.()}>
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <hr />
}))

afterEach(() => {
  cleanup()
})

describe('TerminalContextMenuLinkActions', () => {
  it('renders link-aware actions when the target is a URL (#9279)', () => {
    const onOpenLinkTarget = vi.fn()
    const onCopyLinkTarget = vi.fn()
    render(
      <TerminalContextMenuLinkActions
        linkTarget={{ kind: 'http', url: 'https://example.com', sourceOwner: { kind: 'local' } }}
        onOpenLinkTarget={onOpenLinkTarget}
        onCopyLinkTarget={onCopyLinkTarget}
        onRevealLinkTarget={vi.fn()}
      />
    )

    expect(screen.getByRole('button', { name: 'Open Link' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy Link' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Reveal in File Manager' })).toBeNull()
    screen.getByRole('button', { name: 'Open Link' }).click()
    screen.getByRole('button', { name: 'Copy Link' }).click()
    expect(onOpenLinkTarget).toHaveBeenCalledTimes(1)
    expect(onCopyLinkTarget).toHaveBeenCalledTimes(1)
  })

  it('renders path reveal for file link targets (#9279)', () => {
    const onRevealLinkTarget = vi.fn()
    render(
      <TerminalContextMenuLinkActions
        linkTarget={{
          kind: 'file',
          absolutePath: '/tmp/repo/src/main.ts',
          line: 1,
          column: null,
          pathText: 'src/main.ts'
        }}
        onOpenLinkTarget={vi.fn()}
        onCopyLinkTarget={vi.fn()}
        onRevealLinkTarget={onRevealLinkTarget}
      />
    )

    expect(screen.getByRole('button', { name: 'Open Path' })).toBeTruthy()
    const revealItem = screen.getByRole('button', { name: 'Reveal in File Manager' })
    revealItem.click()
    expect(onRevealLinkTarget).toHaveBeenCalledTimes(1)
  })
})
