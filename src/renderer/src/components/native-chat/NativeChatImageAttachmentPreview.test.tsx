// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { NativeChatImageAttachmentPreview } from './NativeChatImageAttachmentPreview'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'

const mocks = vi.hoisted(() => ({
  useLocalImageSrc: vi.fn()
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, string>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => options?.[name] ?? '')
}))

vi.mock('@/components/editor/useLocalImageSrc', () => ({
  useLocalImageSrc: mocks.useLocalImageSrc
}))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  mocks.useLocalImageSrc.mockReset()
})

function renderPreview(
  attachment: NativeChatComposerImageAttachment,
  hostEnvironmentId?: string
): void {
  vi.stubGlobal('IntersectionObserver', undefined)
  render(
    <NativeChatImageAttachmentPreview
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
  it('shows the clipboard thumbnail and a spinner while pending', () => {
    mocks.useLocalImageSrc.mockReturnValue(undefined)
    renderPreview({ id: 'a1', path: '', previewUrl: 'blob:clipboard-1', pending: true })

    expect(document.querySelector('.animate-spin')).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Saving pasted image…' }).getAttribute('src')).toBe(
      'blob:clipboard-1'
    )
  })

  it('renders no spinner once the attachment has settled', () => {
    mocks.useLocalImageSrc.mockReturnValue('blob:on-disk-1')
    renderPreview({ id: 'a1', path: '/tmp/example.png' })

    expect(document.querySelector('.animate-spin')).toBeFalsy()
  })

  it('does not read the on-disk file while the attachment is pending', () => {
    mocks.useLocalImageSrc.mockReturnValue(undefined)
    renderPreview({ id: 'a1', path: '', previewUrl: 'blob:clipboard-1', pending: true })

    expect(mocks.useLocalImageSrc).toHaveBeenCalledWith(undefined, '', undefined, undefined, {
      kind: 'chat-image'
    })
  })

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

  it("keeps any other path on the chat's usual read route", () => {
    mocks.useLocalImageSrc.mockReturnValue(undefined)
    renderPreview({ id: 'a1', path: '/repo/docs/shot.png' }, 'env-1')

    expect(mocks.useLocalImageSrc).toHaveBeenCalledWith(
      '/repo/docs/shot.png',
      '/repo/docs/shot.png',
      undefined,
      undefined,
      { kind: 'chat-image' }
    )
  })

  it('shows a dropped file by name and kind while it uploads', () => {
    mocks.useLocalImageSrc.mockReturnValue(undefined)
    renderPreview({ id: 'a1', path: '', pending: true, pendingName: 'report.pdf' })

    expect(screen.getByRole('button', { name: 'Uploading report.pdf…' })).toBeTruthy()
    expect(screen.getByText('report.pdf')).toBeTruthy()
    expect(document.querySelector('.lucide-file-text')).toBeTruthy()
    expect(document.querySelector('.lucide-image')).toBeFalsy()
  })

  it('shows a dropped image as an image while it uploads', () => {
    mocks.useLocalImageSrc.mockReturnValue(undefined)
    renderPreview({ id: 'a1', path: '', pending: true, pendingName: 'shot.png' })

    expect(screen.getByText('shot.png')).toBeTruthy()
    expect(document.querySelector('.lucide-image')).toBeTruthy()
  })

  it('offers the full-size file, not the clipboard thumbnail, to the chat copy menu', () => {
    mocks.useLocalImageSrc.mockReturnValue('blob:on-disk-1')
    renderPreview({ id: 'a1', path: '/tmp/example.png', previewUrl: 'data:thumbnail' })

    const thumbnail = screen.getByRole('button', { name: 'View image: example.png' })
    expect(thumbnail.getAttribute('data-native-chat-copy-image-src')).toBe('blob:on-disk-1')
  })

  it('offers nothing to copy until the file is readable or in the web client', () => {
    mocks.useLocalImageSrc.mockReturnValue(undefined)
    renderPreview({ id: 'a1', path: '/tmp/example.png', previewUrl: 'data:thumbnail' })
    expect(
      screen
        .getByRole('button', { name: 'View image: example.png' })
        .hasAttribute('data-native-chat-copy-image-src')
    ).toBe(false)

    mocks.useLocalImageSrc.mockReturnValue('blob:on-disk-2')
    renderPreview({ id: 'a2', path: '/tmp/logo.SVG' })
    expect(
      screen
        .getByRole('button', { name: 'View image: logo.SVG' })
        .hasAttribute('data-native-chat-copy-image-src')
    ).toBe(true)

    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    renderPreview({ id: 'a3', path: '/tmp/shot.png' })
    expect(
      screen
        .getByRole('button', { name: 'View image: shot.png' })
        .hasAttribute('data-native-chat-copy-image-src')
    ).toBe(false)
  })

  it('stays open through a click on the chat context menu, but not elsewhere outside', async () => {
    mocks.useLocalImageSrc.mockReturnValue('blob:on-disk-1')
    renderPreview({ id: 'a1', path: '/tmp/example.png', previewUrl: 'data:thumbnail' })
    fireEvent.click(screen.getByRole('button', { name: 'View image: example.png' }))
    expect(
      within(screen.getByRole('dialog'))
        .getByRole('img')
        .getAttribute('data-native-chat-copy-image-src')
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

  it('shows a pasted image that could not come back by name, says it was not kept, and lets it be removed', () => {
    mocks.useLocalImageSrc.mockReturnValue(undefined)
    const onRemove = vi.fn()
    vi.stubGlobal('IntersectionObserver', undefined)
    render(
      <NativeChatImageAttachmentPreview
        attachment={{ id: 'm1', path: '', unavailableName: 'orca-paste-1-ab.png' }}
        onRemove={onRemove}
      />
    )

    expect(
      screen.getByRole('img', {
        name: "This pasted image couldn't be brought back with this draft. Remove it, and paste it again if you still need it."
      })
    ).toBeTruthy()
    expect(screen.getByText('Pasted image')).toBeTruthy()
    expect(screen.getByText('Not kept')).toBeTruthy()
    screen.getByRole('button', { name: 'Remove attachment' }).click()
    expect(onRemove).toHaveBeenCalledWith('m1')
  })

  it('shows a file that could not come back by name, with a visible attach-again hint', () => {
    mocks.useLocalImageSrc.mockReturnValue(undefined)
    vi.stubGlobal('IntersectionObserver', undefined)
    render(
      <NativeChatImageAttachmentPreview
        attachment={{ id: 'm2', path: '', unavailableName: 'diagram.png' }}
        onRemove={vi.fn()}
      />
    )

    expect(
      screen.getByRole('img', {
        name: "diagram.png couldn't be brought back with this draft. Attach it again or remove it."
      })
    ).toBeTruthy()
    expect(screen.getByText('diagram.png')).toBeTruthy()
    expect(screen.getByText('Attach again')).toBeTruthy()
  })
})
