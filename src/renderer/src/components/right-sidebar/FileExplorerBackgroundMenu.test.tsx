// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { FileExplorerBackgroundMenu } from './FileExplorerBackgroundMenu'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderMenu(options: { onPasteImage?: () => void; isPastingImage?: boolean } = {}) {
  return render(
    <FileExplorerBackgroundMenu
      open
      onOpenChange={vi.fn()}
      point={{ x: 0, y: 0 }}
      worktreePath="/notes/images"
      onStartNew={vi.fn()}
      {...options}
    />
  )
}

it.each(['Windows', 'Macintosh', 'Linux'])(
  'shows the %s shortcut and invokes paste once',
  async (platform) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(platform)
    const onPasteImage = vi.fn()
    renderMenu({ onPasteImage })
    const item = screen.getByRole('menuitem', { name: /Paste Image/ })
    expect(item.textContent).toContain(platform === 'Macintosh' ? '⌘V' : 'Ctrl+V')
    await act(async () => {
      fireEvent.click(item)
    })
    expect(onPasteImage).toHaveBeenCalledExactlyOnceWith()
  }
)

it('keeps the paste action disabled during an import', async () => {
  const onPasteImage = vi.fn()
  renderMenu({ onPasteImage, isPastingImage: true })
  const item = screen.getByRole('menuitem', { name: /Paste Image/ })
  expect(item.getAttribute('aria-disabled')).toBe('true')
  await act(async () => {
    fireEvent.click(item)
  })
  expect(onPasteImage).not.toHaveBeenCalled()
})

it('omits paste when unsupported and retains file creation actions', () => {
  renderMenu()
  expect(screen.queryByRole('menuitem', { name: /Paste Image/ })).toBeNull()
  expect(screen.getByRole('menuitem', { name: 'New File' })).toBeDefined()
  expect(screen.getByRole('menuitem', { name: 'New Folder' })).toBeDefined()
})
