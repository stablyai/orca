/**
 * @vitest-environment happy-dom
 */
import React, { createRef, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ImageBlobPng from '@/lib/image-blob-png'
import { CLIPBOARD_IMAGE_MAX_SOURCE_BYTES } from '../../../../shared/clipboard-image'
import {
  emptyNativeChatContextMenuActions,
  useNativeChatContextMenu,
  type NativeChatContextMenuActions
} from './use-native-chat-context-menu'

type ItemProps = { onSelect?: () => void; children?: ReactNode }

const items = vi.hoisted(() => ({ list: [] as ItemProps[] }))
const imageCopy = vi.hoisted(() => ({
  convertImageBlobToPng: vi.fn()
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children?: ReactNode }) => children,
  DropdownMenuContent: ({ children }: { children?: ReactNode }) => children,
  DropdownMenuItem: (props: ItemProps) => {
    items.list.push(props)
    return props.children
  },
  DropdownMenuLabel: ({ children }: { children?: ReactNode }) => children,
  DropdownMenuSeparator: () => null,
  DropdownMenuShortcut: ({ children }: { children?: ReactNode }) => children,
  DropdownMenuSub: ({ children }: { children?: ReactNode }) => children,
  DropdownMenuSubContent: ({ children }: { children?: ReactNode }) => children,
  DropdownMenuSubTrigger: ({ children }: { children?: ReactNode }) => children,
  DropdownMenuTrigger: ({ children }: { children?: ReactNode }) => children
}))

vi.mock('lucide-react', () => {
  const Icon = () => null
  return {
    Clipboard: Icon,
    Copy: Icon,
    GitFork: Icon,
    Image: Icon,
    Maximize2: Icon,
    MessageSquarePlus: Icon,
    Minimize2: Icon,
    PanelBottomClose: Icon,
    PanelsTopLeft: Icon,
    PanelRightClose: Icon,
    Pencil: Icon,
    SquareTerminal: Icon,
    X: Icon
  }
})

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts }))

const tooltips = vi.hoisted((): { list: ReactNode[] } => ({ list: [] }))
vi.mock('@/components/ui/tooltip', () => {
  const Pass = ({ children }: { children?: ReactNode }) => children
  return {
    Tooltip: Pass,
    TooltipTrigger: Pass,
    TooltipContent: ({ children }: { children?: ReactNode }) => {
      tooltips.list.push(children)
      return null
    }
  }
})
vi.mock('@/lib/image-blob-png', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageBlobPng>()),
  convertImageBlobToPng: imageCopy.convertImageBlobToPng
}))

vi.mock('@/components/tab-bar/TabWorkspaceLayoutMenuSection', () => ({
  TabWorkspaceLayoutMenuSection: () => 'Move Tab to Split'
}))

function childrenText(children: ReactNode): string {
  return React.Children.toArray(children)
    .map((child) => {
      if (typeof child === 'string') {
        return child
      }
      return React.isValidElement<{ children?: ReactNode }>(child)
        ? childrenText(child.props.children)
        : ''
    })
    .join('')
}

function Harness({
  onSwitchToTerminal,
  structured = false,
  enabled = true,
  orcaSessionId
}: {
  onSwitchToTerminal?: () => void
  structured?: boolean
  enabled?: boolean
  orcaSessionId?: string
}) {
  const rootRef = createRef<HTMLDivElement>()
  const { menu } = useNativeChatContextMenu({
    rootRef,
    enabled,
    onSwitchToTerminal,
    showTerminalPaneActions: !structured,
    workspaceLayout: structured ? { unifiedTabId: 'chat-tab', groupId: 'group-1' } : undefined,
    resolveOrcaSessionId: orcaSessionId === undefined ? undefined : async () => orcaSessionId,
    actions: {
      ...emptyNativeChatContextMenuActions,
      onPaste: vi.fn()
    } satisfies NativeChatContextMenuActions
  })
  return menu
}

function ImageHarness({
  enabled = true,
  src = 'blob:full-size'
}: {
  enabled?: boolean
  src?: string
}) {
  const rootRef = createRef<HTMLDivElement>()
  const { menu, onContextMenuCapture } = useNativeChatContextMenu({
    rootRef,
    enabled,
    actions: { ...emptyNativeChatContextMenuActions, onPaste: vi.fn() }
  })
  return (
    <div ref={rootRef} onContextMenuCapture={onContextMenuCapture}>
      <button type="button" data-native-chat-copy-image-src={src}>
        <img alt="shot" src="data:thumbnail" />
      </button>
      <p>text</p>
      {menu}
    </div>
  )
}

function copyImageItem(): ItemProps | undefined {
  return items.list.findLast((candidate) => childrenText(candidate.children) === 'Copy image')
}

function stubClipboardImageWrite(): ReturnType<typeof vi.fn> {
  const writeClipboardImage = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('api', { ui: { writeClipboardImage } })
  return writeClipboardImage
}

async function rightClickImageAndCopy({
  blobFor = (src: string) => new Blob([src]),
  revokeBeforeSelect = false
}: { blobFor?: (src: string) => Blob; revokeBeforeSelect?: boolean } = {}): Promise<{
  writeClipboardImage: ReturnType<typeof vi.fn>
}> {
  const writeClipboardImage = stubClipboardImageWrite()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (src: string) => ({ ok: true, blob: async () => blobFor(src) }))
  )
  render(<ImageHarness />)
  fireEvent.contextMenu(screen.getByRole('img', { name: 'shot' }))
  if (revokeBeforeSelect) {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
  }
  await act(async () => copyImageItem()?.onSelect?.())
  return { writeClipboardImage }
}

function pngOfText(): void {
  imageCopy.convertImageBlobToPng.mockImplementation(
    async (blob: Blob) => new Blob([`png:${await blob.text()}`], { type: 'image/png' })
  )
}

describe('useNativeChatContextMenu', () => {
  beforeEach(() => {
    items.list = []
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    imageCopy.convertImageBlobToPng.mockReset()
    toasts.error.mockReset()
    toasts.success.mockReset()
  })

  it('copies the right-clicked image as a PNG of its full-size source', async () => {
    pngOfText()

    const { writeClipboardImage } = await rightClickImageAndCopy()

    await waitFor(() =>
      expect(writeClipboardImage).toHaveBeenCalledWith(
        `data:image/png;base64,${Buffer.from('png:blob:full-size').toString('base64')}`
      )
    )
    expect(toasts.success).toHaveBeenCalledWith('Image copied')
    expect(toasts.error).not.toHaveBeenCalled()
  })

  it('offers no image copy when the right-click is not on an image', () => {
    render(<ImageHarness />)
    fireEvent.contextMenu(screen.getByText('text'))

    expect(copyImageItem()).toBeUndefined()
  })

  it('copies an image whose blob URL was revoked after the menu opened', async () => {
    pngOfText()

    const { writeClipboardImage } = await rightClickImageAndCopy({ revokeBeforeSelect: true })

    await waitFor(() => expect(writeClipboardImage).toHaveBeenCalledOnce())
    expect(toasts.error).not.toHaveBeenCalled()
  })

  it('releases the read image when the pane hides with the menu open', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, blob: async () => new Blob(['image']) }))
    )
    const { rerender } = render(<ImageHarness />)
    fireEvent.contextMenu(screen.getByRole('img', { name: 'shot' }))
    expect(copyImageItem()).toBeDefined()

    rerender(<ImageHarness enabled={false} />)
    // Inspect a render after the hide effect has settled.
    items.list = []
    rerender(<ImageHarness enabled={false} />)

    expect(copyImageItem()).toBeUndefined()
  })

  it.each(['http://example.test/original.png', 'https://example.test/original.svg'])(
    'reads %s only after Copy image is selected',
    async (src) => {
      pngOfText()
      const writeClipboardImage = stubClipboardImageWrite()
      const fetchImage = vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob([src]) })
      vi.stubGlobal('fetch', fetchImage)
      render(<ImageHarness src={src} />)
      fireEvent.contextMenu(screen.getByRole('img', { name: 'shot' }))
      expect(copyImageItem()).toBeDefined()
      expect(fetchImage).not.toHaveBeenCalled()

      await act(async () => copyImageItem()?.onSelect?.())

      await waitFor(() => expect(writeClipboardImage).toHaveBeenCalledOnce())
      expect(fetchImage).toHaveBeenCalledOnce()
      expect(fetchImage).toHaveBeenCalledWith(src)
      expect(writeClipboardImage).toHaveBeenCalledOnce()
      expect(toasts.success).toHaveBeenCalledWith('Image copied')
    }
  )

  it.each([
    ['HTTP failure', () => Promise.resolve({ ok: false, status: 404, blob: vi.fn() })],
    ['network failure', () => Promise.reject(new TypeError('Failed to fetch'))],
    [
      'HTML response',
      () =>
        Promise.resolve({ ok: true, blob: async () => new Blob(['page'], { type: 'text/html' }) })
    ]
  ])(
    'reports one error for %s with no clipboard write or file fallback',
    async (_label, response) => {
      const writeClipboardImage = stubClipboardImageWrite()
      const fetchImage = vi.fn(response)
      vi.stubGlobal('fetch', fetchImage)
      render(<ImageHarness src="https://example.test/original.png" />)
      fireEvent.contextMenu(screen.getByRole('img', { name: 'shot' }))

      await act(async () => copyImageItem()?.onSelect?.())

      await waitFor(() => expect(toasts.error).toHaveBeenCalledOnce())
      expect(fetchImage).toHaveBeenCalledOnce()
      expect(imageCopy.convertImageBlobToPng).not.toHaveBeenCalled()
      expect(writeClipboardImage).not.toHaveBeenCalled()
      expect(toasts.error).toHaveBeenCalledOnce()
      expect(toasts.success).not.toHaveBeenCalled()
    }
  )

  it('captures a data image before selection and keeps it when the source disappears', async () => {
    pngOfText()
    const writeClipboardImage = stubClipboardImageWrite()
    const fetchImage = vi
      .fn()
      .mockResolvedValue({ ok: true, blob: async () => new Blob(['inline']) })
    vi.stubGlobal('fetch', fetchImage)
    render(<ImageHarness src="data:image/png;base64,aW5saW5l" />)
    fireEvent.contextMenu(screen.getByRole('img', { name: 'shot' }))
    expect(fetchImage).toHaveBeenCalledOnce()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Source gone')))

    await act(async () => copyImageItem()?.onSelect?.())

    await waitFor(() => expect(writeClipboardImage).toHaveBeenCalledOnce())
    expect(toasts.success).toHaveBeenCalledOnce()
  })

  it('reports an image too large to copy instead of copying nothing silently', async () => {
    const actual = await vi.importActual<typeof ImageBlobPng>('@/lib/image-blob-png')
    imageCopy.convertImageBlobToPng.mockImplementation(actual.convertImageBlobToPng)

    const { writeClipboardImage } = await rightClickImageAndCopy({
      blobFor: () => new Blob([new Uint8Array(CLIPBOARD_IMAGE_MAX_SOURCE_BYTES + 1)])
    })

    await waitFor(() => expect(toasts.error).toHaveBeenCalled())
    expect(writeClipboardImage).not.toHaveBeenCalled()
    expect(toasts.success).not.toHaveBeenCalled()
    expect(toasts.error).toHaveBeenCalledWith("Couldn't copy image", {
      description: 'The image is too large to copy.'
    })
  })

  it('restores the bridge switch-to-terminal action when supplied', () => {
    const onSwitchToTerminal = vi.fn()

    renderToStaticMarkup(<Harness onSwitchToTerminal={onSwitchToTerminal} />)

    // Keep the assertions tied to the mocked menu item's semantic children.
    const labels = items.list.map((candidate) => childrenText(candidate.children))

    expect(labels.some((label) => label.startsWith('Switch to terminal view'))).toBe(true)
    const item = items.list.find((candidate) =>
      childrenText(candidate.children).startsWith('Switch to terminal view')
    )
    expect(item).toBeDefined()
    item?.onSelect?.()
    expect(onSwitchToTerminal).toHaveBeenCalledTimes(1)
  })

  it('does not render a terminal switch action without a bridge callback', () => {
    renderToStaticMarkup(<Harness />)

    expect(
      items.list.some((candidate) => childrenText(candidate.children) === 'Switch to terminal view')
    ).toBe(false)
  })

  it('reuses workspace layout actions without terminal-only pane commands', () => {
    const markup = renderToStaticMarkup(<Harness structured />)

    expect(markup).toContain('Move Tab to Split')
    expect(markup).not.toContain('Split Terminal Right')
    expect(markup).not.toContain('Fork Agent Session')
  })

  it('subscribes to selection changes only while its retained chat is visible', () => {
    const getSelection = vi.spyOn(window, 'getSelection').mockReturnValue(null)
    const view = render(<Harness enabled={false} />)

    getSelection.mockClear()
    document.dispatchEvent(new Event('selectionchange'))
    expect(getSelection).not.toHaveBeenCalled()

    view.rerender(<Harness enabled />)
    getSelection.mockClear()
    document.dispatchEvent(new Event('selectionchange'))
    expect(getSelection).toHaveBeenCalledOnce()

    view.rerender(<Harness enabled={false} />)
    getSelection.mockClear()
    document.dispatchEvent(new Event('selectionchange'))
    expect(getSelection).not.toHaveBeenCalled()
  })

  describe('Copy Orca Session ID', () => {
    const orcaSessionId = 'orca_session_id:4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37'
    const writeClipboardText = vi.fn()

    beforeEach(() => {
      writeClipboardText.mockReset().mockResolvedValue(undefined)
      toasts.success.mockReset()
      toasts.error.mockReset()
      tooltips.list = []
      Object.assign(window, { api: { ui: { writeClipboardText } } })
    })

    function labels(): string[] {
      return items.list.map((candidate) => childrenText(candidate.children))
    }

    function copyItem(): ItemProps | undefined {
      return items.list.find(
        (candidate) => childrenText(candidate.children) === 'Copy Orca Session ID'
      )
    }

    it('copies the Orca session ID in a chat tab, explaining what it is', async () => {
      renderToStaticMarkup(<Harness structured orcaSessionId={orcaSessionId} />)

      copyItem()?.onSelect?.()

      await vi.waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Orca session ID copied'))
      expect(writeClipboardText).toHaveBeenCalledWith(orcaSessionId)
      expect(tooltips.list.map(childrenText)).toContain(
        "Orca's ID for this chat, separate from the agent CLI's own session ID. Agents use it to refer to each other through Orca."
      )
    })

    it('is absent for a chat with no Orca session ID', () => {
      renderToStaticMarkup(<Harness structured />)

      expect(labels()).not.toContain('Copy Orca Session ID')
    })

    it('reports a failed copy instead of claiming success', async () => {
      writeClipboardText.mockRejectedValue(new Error('denied'))
      renderToStaticMarkup(<Harness structured orcaSessionId={orcaSessionId} />)

      copyItem()?.onSelect?.()

      await vi.waitFor(() =>
        expect(toasts.error).toHaveBeenCalledWith('Unable to copy Orca session ID')
      )
      expect(toasts.success).not.toHaveBeenCalled()
    })
  })
})
