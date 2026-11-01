// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import { LinkActionPopover } from '@/components/link-actions/LinkActionPopover'
import type { LinkActionRequest } from '@/components/link-actions/link-action-request'
import { TooltipProvider } from '@/components/ui/tooltip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileLinkTarget } from '../terminal-file-link-target'
import type { TerminalFilePeekContent } from './terminal-file-peek-content-types'

const { loadTerminalFilePeek } = vi.hoisted(() => ({
  loadTerminalFilePeek:
    vi.fn<
      (target: FileLinkTarget, signal: AbortSignal) => Promise<TerminalFilePeekContent | null>
    >()
}))

vi.mock('./terminal-file-peek-content', () => ({ loadTerminalFilePeek }))

import { TerminalLinkFilePreview } from './TerminalLinkFilePreview'

const FIRST_TARGET: FileLinkTarget = {
  absolutePath: '/repo/first.bin',
  line: null,
  column: null,
  fileContext: {
    target: { kind: 'local' },
    worktreeId: 'worktree-1',
    worktreePath: '/repo',
    sourceHostResolved: true
  },
  isRemoteRuntimePath: false,
  cacheKey: 'active\0/repo/first.bin',
  isKnownWorktreeRoot: false
}
const SECOND_TARGET: FileLinkTarget = {
  ...FIRST_TARGET,
  absolutePath: '/repo/second.pdf',
  cacheKey: 'active\0/repo/second.pdf'
}
const FIRST_CONTENT: TerminalFilePeekContent = {
  kind: 'notice',
  path: FIRST_TARGET.absolutePath,
  reason: 'binary'
}

const MENU_REQUEST: LinkActionRequest = {
  anchorX: 100,
  anchorY: 200,
  destination: FIRST_TARGET.absolutePath,
  kind: 'file',
  primary: { label: 'Open file', run: vi.fn() },
  restoreFocus: vi.fn()
}
const HAS_PREVIEW = ':has(> [data-slot="link-action-preview"]:not(:empty))'

function pendingPeek() {
  let resolve!: (content: TerminalFilePeekContent | null) => void
  const promise = new Promise<TerminalFilePeekContent | null>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

beforeEach(() => loadTerminalFilePeek.mockReset())
afterEach(cleanup)

describe('TerminalLinkFilePreview', () => {
  it('replaces resolved content with loading immediately when the target changes', async () => {
    const first = pendingPeek()
    const second = pendingPeek()
    loadTerminalFilePeek.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const { rerender } = render(<TerminalLinkFilePreview target={FIRST_TARGET} />)
    await act(async () => first.resolve(FIRST_CONTENT))
    expect(screen.getByText('Binary file, no preview.')).toBeTruthy()

    rerender(<TerminalLinkFilePreview target={SECOND_TARGET} />)

    expect(screen.queryByText('Binary file, no preview.')).toBeNull()
    expect(screen.getByRole('status', { name: 'Loading preview' })).toBeTruthy()
    expect(loadTerminalFilePeek.mock.calls[0]?.[1].aborted).toBe(true)
    expect(loadTerminalFilePeek.mock.calls[1]?.[1].aborted).toBe(false)
    await act(async () =>
      second.resolve({ kind: 'notice', path: SECOND_TARGET.absolutePath, reason: 'unsupported' })
    )
    expect(screen.getByText('No preview for this kind of file.')).toBeTruthy()
  })

  it('ignores a superseded load even when it finishes after the replacement', async () => {
    const first = pendingPeek()
    const second = pendingPeek()
    loadTerminalFilePeek.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const { rerender } = render(<TerminalLinkFilePreview target={FIRST_TARGET} />)
    rerender(<TerminalLinkFilePreview target={SECOND_TARGET} />)
    await act(async () =>
      second.resolve({ kind: 'notice', path: SECOND_TARGET.absolutePath, reason: 'unsupported' })
    )

    await act(async () => first.resolve(FIRST_CONTENT))

    expect(screen.getByText('No preview for this kind of file.')).toBeTruthy()
    expect(screen.queryByText('Binary file, no preview.')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('leaves no section or active wide styling in the menu for an unaddressable result', async () => {
    const pending = pendingPeek()
    loadTerminalFilePeek.mockReturnValue(pending.promise)
    render(
      <TooltipProvider>
        <LinkActionPopover
          request={MENU_REQUEST}
          onClose={vi.fn()}
          preview={<TerminalLinkFilePreview target={FIRST_TARGET} />}
        />
      </TooltipProvider>
    )
    const menu = document.querySelector('[data-link-action-popover]')
    expect(menu?.matches(HAS_PREVIEW)).toBe(true)

    await act(async () => pending.resolve(null))

    expect(document.querySelector('[data-slot="terminal-file-peek-body"]')).toBeNull()
    expect(menu?.querySelector('[data-slot="link-action-preview"]')?.childNodes).toHaveLength(0)
    expect(menu?.matches(HAS_PREVIEW)).toBe(false)
    expect(menu?.className).toContain('max-w-[min(21rem,calc(100vw-1rem))]')
    expect(screen.getByRole('button', { name: /Open file/ })).toBeTruthy()
  })

  it('keeps focus on the action row as a delayed scrollable preview resolves and aborts on menu close', async () => {
    const pending = pendingPeek()
    loadTerminalFilePeek.mockReturnValue(pending.promise)
    const preview = <TerminalLinkFilePreview target={FIRST_TARGET} />
    const { rerender } = render(
      <TooltipProvider>
        <LinkActionPopover request={MENU_REQUEST} onClose={vi.fn()} preview={preview} />
      </TooltipProvider>
    )
    const action = screen.getByRole('button', { name: /Open file/ })
    action.focus()
    await act(async () =>
      pending.resolve({
        kind: 'markdown',
        path: FIRST_TARGET.absolutePath,
        source: 'Delayed preview'
      })
    )

    expect(screen.getByText('Delayed preview')).toBeTruthy()
    expect(document.activeElement).toBe(action)
    const indexedElements = document.querySelectorAll(
      '[data-slot="terminal-file-peek-body"] [tabindex]'
    )
    expect(indexedElements).toHaveLength(1)
    expect(indexedElements[0]?.matches('.overflow-y-auto[tabindex="-1"]')).toBe(true)

    rerender(
      <TooltipProvider>
        <LinkActionPopover request={null} onClose={vi.fn()} preview={preview} />
      </TooltipProvider>
    )
    expect(loadTerminalFilePeek.mock.calls[0]?.[1].aborted).toBe(true)
    expect(document.querySelector('[data-slot="terminal-file-peek-body"]')).toBeNull()
  })

  it('ignores a delayed result after the menu has unmounted', async () => {
    const pending = pendingPeek()
    loadTerminalFilePeek.mockReturnValue(pending.promise)
    const { unmount, container } = render(<TerminalLinkFilePreview target={FIRST_TARGET} />)

    unmount()
    await act(async () => pending.resolve(FIRST_CONTENT))

    expect(loadTerminalFilePeek.mock.calls[0]?.[1].aborted).toBe(true)
    expect(container.childNodes).toHaveLength(0)
  })

  it('shows loading until the menu preview resolves and aborts when unmounted', async () => {
    const pending = pendingPeek()
    loadTerminalFilePeek.mockReturnValue(pending.promise)
    const { unmount } = render(<TerminalLinkFilePreview target={FIRST_TARGET} />)

    expect(screen.getByRole('status', { name: 'Loading preview' })).toBeTruthy()
    const signal = loadTerminalFilePeek.mock.calls[0]?.[1]
    expect(signal?.aborted).toBe(false)

    await act(async () => pending.resolve(FIRST_CONTENT))

    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByText('Binary file, no preview.')).toBeTruthy()
    unmount()
    expect(signal?.aborted).toBe(true)
  })
})
