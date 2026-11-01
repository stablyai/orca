// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { NativeChatImageAttachmentPreview } from './NativeChatImageAttachmentPreview'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'

const mocks = vi.hoisted(() => ({
  useLocalImageSrc: vi.fn(),
  getConnectionIdForFile: vi.fn(() => {
    throw new Error('Image preview fixtures must not resolve editor file connections')
  })
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, string>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => options?.[name] ?? '')
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionIdForFile: mocks.getConnectionIdForFile
}))

vi.mock('@/components/editor/useLocalImageSrc', () => ({
  useLocalImageSrc: mocks.useLocalImageSrc
}))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  mocks.useLocalImageSrc.mockReset()
  expect(mocks.getConnectionIdForFile).not.toHaveBeenCalled()
  mocks.getConnectionIdForFile.mockClear()
})

function renderPreview(
  attachment: NativeChatComposerImageAttachment,
  hostEnvironmentId?: string
): void {
  vi.stubGlobal('IntersectionObserver', undefined)
  render(
    <NativeChatImageAttachmentPreview
      number={1}
      attachment={attachment}
      hostEnvironmentId={hostEnvironmentId}
      onRemove={vi.fn()}
    />
  )
}

async function clickOn(target: Element): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }))
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('NativeChatImageAttachmentPreview', () => {
  // The path names a file on the paired server; this machine's disk must never be asked for it.
  it('reads a stored chip back through the server that holds it', () => {
    mocks.useLocalImageSrc.mockReturnValue('blob:from-server')
    const path = '/srv/agent-session-attachments/u1/shot.png'
    renderPreview({ id: 'a1', path }, 'env-1')

    for (const call of mocks.useLocalImageSrc.mock.calls) {
      expect(call[3]).toEqual({
        target: { kind: 'environment', environmentId: 'env-1' },
        worktreeId: null,
        worktreePath: null
      })
    }
    expect(mocks.useLocalImageSrc).toHaveBeenCalledWith(path, path, undefined, expect.anything(), {
      kind: 'chat-image'
    })
    expect(screen.getByRole('img', { name: 'shot.png' }).getAttribute('src')).toBe(
      'blob:from-server'
    )
  })

  it('offers nothing to copy until the file is readable or in the web client', () => {
    mocks.useLocalImageSrc.mockReturnValue(undefined)
    renderPreview({ id: 'a1', path: '/tmp/example.png', previewUrl: 'data:thumbnail' })
    expect(
      screen
        .getByRole('button', { name: 'Image #1: View image: example.png' })
        .hasAttribute('data-native-chat-copy-image-src')
    ).toBe(false)

    mocks.useLocalImageSrc.mockReturnValue('blob:on-disk-2')
    renderPreview({ id: 'a2', path: '/tmp/logo.SVG' })
    expect(
      screen
        .getByRole('button', { name: 'Image #1: View image: logo.SVG' })
        .hasAttribute('data-native-chat-copy-image-src')
    ).toBe(true)

    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    renderPreview({ id: 'a3', path: '/tmp/shot.png' })
    expect(
      screen
        .getByRole('button', { name: 'Image #1: View image: shot.png' })
        .hasAttribute('data-native-chat-copy-image-src')
    ).toBe(false)
  })

  it('stays open through a click on the chat context menu, but not elsewhere outside', async () => {
    mocks.useLocalImageSrc.mockReturnValue('blob:on-disk-1')
    renderPreview({ id: 'a1', path: '/tmp/example.png', previewUrl: 'data:thumbnail' })
    fireEvent.click(screen.getByRole('button', { name: 'Image #1: View image: example.png' }))
    expect(
      within(screen.getByRole('dialog'))
        .getByTestId('pan-zoom-image-canvas')
        .closest('[data-native-chat-copy-image-src]')
        ?.getAttribute('data-native-chat-copy-image-src')
    ).toBe('blob:on-disk-1')
    const menu = document.body.appendChild(document.createElement('div'))
    menu.setAttribute('data-native-chat-context-menu', '')
    const copyItem = menu.appendChild(document.createElement('div'))
    const elsewhere = document.body.appendChild(document.createElement('div'))
    // Radix arms its outside-pointer listener a tick after the dialog opens.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))

    await clickOn(copyItem)
    expect(screen.queryByRole('dialog')).toBeTruthy()

    await clickOn(elsewhere)
    expect(screen.queryByRole('dialog')).toBeNull()
    menu.remove()
    elsewhere.remove()
  })

  it('highlights a failed attachment with error styling and red badge', () => {
    mocks.useLocalImageSrc.mockReturnValue('blob:on-disk')
    renderPreview({
      id: 'a1',
      path: '/tmp/oversized.png',
      failed: true,
      error: 'Image #1 (oversized.png, 5.5 MB) is larger than 5 MB, so the message was not sent.'
    })

    const button = screen.getByRole('button', { name: /oversized\.png/ })
    expect(button.className).toContain('border-destructive')
    expect(button.getAttribute('title')).toBe(
      'Image #1 (oversized.png, 5.5 MB) is larger than 5 MB, so the message was not sent.'
    )
    const badge = screen.getByText('#1')
    expect(badge.className).toContain('bg-destructive')
  })

  it('detects oversized image via window.api.fs.stat and applies failed styling', async () => {
    mocks.useLocalImageSrc.mockReturnValue('blob:on-disk')
    const stat = vi.fn().mockResolvedValue({ size: 6 * 1024 * 1024 })
    vi.stubGlobal('api', { fs: { stat } })

    await act(async () => {
      renderPreview({
        id: 'a1',
        path: '/tmp/huge.png'
      })
    })

    const button = screen.getByRole('button', { name: /huge\.png/ })
    expect(button.className).toContain('border-destructive')
    expect(button.getAttribute('title')).toContain('larger than 5 MB')
    const badge = screen.getByText('#1')
    expect(badge.className).toContain('bg-destructive')
  })
})
