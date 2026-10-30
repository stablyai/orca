// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { NativeChatImageAttachmentPreview } from './NativeChatImageAttachmentPreview'
import type { NativeChatComposerImageAttachment } from './native-chat-image-attachment'

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

vi.mock('@/lib/workspace/ownership/connection-context', () => ({
  getConnectionIdForFile: mocks.getConnectionIdForFile
}))

vi.mock('@/components/editor/document-images/useLocalImageSrc', () => ({
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
  it.each([
    {
      name: 'client-local attachment in a remote chat',
      attachment: { id: 'local', path: '/tmp/client-shot.png' },
      hostEnvironmentId: 'env-1',
      canOpenLocally: true
    },
    {
      name: 'attachment stored on the paired server',
      attachment: { id: 'server', path: '/srv/agent-session-attachments/u1/shot.png' },
      hostEnvironmentId: 'env-1',
      canOpenLocally: false
    },
    {
      name: 'attachment read through SSH',
      attachment: { id: 'ssh', path: '/tmp/ssh-shot.png', connectionId: 'ssh-1' },
      hostEnvironmentId: undefined,
      canOpenLocally: false
    }
  ])(
    'offers local file actions only for a $name that belongs to this computer',
    ({ attachment, hostEnvironmentId, canOpenLocally }) => {
      mocks.useLocalImageSrc.mockReturnValue('blob:full-size')
      renderPreview(attachment, hostEnvironmentId)
      fireEvent.contextMenu(screen.getByRole('button', { name: /View image:/ }))

      expect(screen.queryByRole('menuitem', { name: 'Open with default app' }) !== null).toBe(
        canOpenLocally
      )
      expect(screen.getByRole('menuitem', { name: 'Copy image path' })).toBeTruthy()
    }
  )

  it.each([
    { name: 'pending upload', attachment: { id: 'pending', path: '', pending: true } },
    { name: 'unreadable stored file', attachment: { id: 'stored', path: '/tmp/shot.png' } }
  ])('does not copy or save a thumbnail for a $name', async ({ attachment }) => {
    mocks.useLocalImageSrc.mockReturnValue(undefined)
    renderPreview({ ...attachment, previewUrl: 'data:image/png;base64,dGh1bWJuYWls' })
    fireEvent.click(screen.getByRole('button', { name: /^Image #1:/ }))
    await userEvent.setup().click(screen.getByRole('button', { name: 'Image actions' }))

    expect(screen.getByRole('menuitem', { name: 'Copy image' }).hasAttribute('data-disabled')).toBe(
      true
    )
    expect(
      screen.getByRole('menuitem', { name: 'Save image as…' }).hasAttribute('data-disabled')
    ).toBe(true)
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
})
