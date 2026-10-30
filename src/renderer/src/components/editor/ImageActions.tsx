import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode
} from 'react'
import { MoreHorizontal } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import {
  captureImageSource,
  copyImageSource,
  imageDownloadName,
  saveImageSource,
  type ReadImageSource
} from '@/lib/image-source-actions'
import {
  getLocalPathOpenOwnerHostId,
  isLocalPathOpenBlocked,
  type LocalPathOpenOwner
} from '@/lib/local-path-open-guard'
import { getRevealInFileManagerLabel, revealInFileManager } from '@/lib/reveal-in-file-manager'
import { isWebClientLocation } from '@/lib/web-client-location'

export type ImageActionSource = { path: string; localOwner?: LocalPathOpenOwner }
const ImageActionsEnabledContext = createContext(true)
export function ImageActionsScope({
  enabled,
  children,
  ...props
}: ComponentProps<'div'> & { enabled: boolean }): React.JSX.Element {
  return (
    <ImageActionsEnabledContext.Provider value={enabled}>
      <div tabIndex={-1} {...props}>
        {children}
      </div>
    </ImageActionsEnabledContext.Provider>
  )
}
type Props = { src: string | null | undefined; title: string; imageSource?: ImageActionSource }

function useImageActions({ src, title, imageSource }: Props) {
  const enabled = useContext(ImageActionsEnabledContext)
  const [open, setOpen] = useState(false)
  const readRef = useRef<ReadImageSource | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!enabled) {
      setOpen(false)
      readRef.current = null
    }
  }, [enabled])
  const web = isWebClientLocation()
  const path = imageSource?.path
  const link = !path && src && /^https?:/i.test(src) ? src : undefined
  const owner = imageSource?.localOwner
  const local = !web && owner !== undefined && !isLocalPathOpenBlocked(owner)
  const items: { label: string; disabled?: boolean; run: () => Promise<unknown> }[] = []
  const read = (): Promise<Blob> => {
    const image = readRef.current ?? (src ? captureImageSource(src) : null)
    if (!image) {
      throw new Error('Image unavailable')
    }
    return image()
  }
  if (!web) {
    items.push(
      {
        label: translate('components.native-chat.composer.copyImage', 'Copy image'),
        disabled: !src,
        run: () => copyImageSource(read)
      },
      {
        label: translate('components.editor.imageActions.saveAs', 'Save image as…'),
        disabled: !src,
        run: async () => {
          const blob = await read()
          const result = await saveImageSource(
            () => Promise.resolve(blob),
            imageDownloadName(src ?? '', title, blob.type, path)
          )
          if (!result.canceled) {
            toast.success(translate('components.editor.imageActions.saved', 'Image saved'))
          }
        }
      }
    )
  }
  if (path || link) {
    items.push({
      label: path
        ? translate('components.editor.imageActions.copyPath', 'Copy image path')
        : translate('components.editor.imageActions.copyLink', 'Copy image link'),
      run: async () => {
        await window.api.ui.writeClipboardText(path ?? link ?? '')
        toast.success(
          path
            ? translate('components.editor.imageActions.pathCopied', 'Image path copied')
            : translate('components.editor.imageActions.linkCopied', 'Image link copied')
        )
      }
    })
  }
  if (path && local && owner !== undefined) {
    items.push({
      label: getRevealInFileManagerLabel(),
      run: () => revealInFileManager(path, owner)
    })
    const ownerHostId = getLocalPathOpenOwnerHostId(owner)
    if (ownerHostId !== 'unresolved') {
      items.push({
        label: translate(
          'auto.components.terminal.pane.TerminalLinkActionPopover.openWithDefaultApp',
          'Open with default app'
        ),
        run: () => window.api.shell.openPath(path, ownerHostId)
      })
    }
  }
  return {
    items,
    busy,
    enabled,
    open: enabled && open,
    onOpenChange: (nextOpen: boolean) => {
      if (!enabled) {
        return
      }
      setOpen(nextOpen)
      if (nextOpen) {
        readRef.current = src ? captureImageSource(src) : null
      } else {
        readRef.current = null
      }
    },
    run: async (action: () => Promise<unknown>) => {
      setBusy(true)
      try {
        await action()
      } catch {
        toast.error(translate('components.editor.imageActions.failed', 'Image action failed'))
      } finally {
        setBusy(false)
      }
    }
  }
}

export function ImageActions({
  children,
  ...props
}: Props & { children: ReactNode }): React.JSX.Element {
  const actions = useImageActions(props)
  if (actions.items.length === 0) {
    return <>{children}</>
  }
  return (
    <ContextMenu open={actions.open} onOpenChange={actions.onOpenChange}>
      <ContextMenuTrigger className="contents" data-image-actions="">
        {children}
      </ContextMenuTrigger>
      {actions.enabled && (
        <ContextMenuContent data-image-actions-menu="" onClick={(event) => event.stopPropagation()}>
          {actions.items.map((item) => (
            <ContextMenuItem
              key={item.label}
              disabled={actions.busy || item.disabled}
              onSelect={() => void actions.run(item.run)}
            >
              {item.label}
            </ContextMenuItem>
          ))}
        </ContextMenuContent>
      )}
    </ContextMenu>
  )
}

export function ImageActionsButton(props: Props): React.JSX.Element | null {
  const actions = useImageActions(props)
  const triggerRef = useRef<HTMLButtonElement>(null)
  if (actions.items.length === 0) {
    return null
  }
  return (
    <DropdownMenu modal={false} open={actions.open} onOpenChange={actions.onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          ref={triggerRef}
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={actions.busy}
          aria-label={translate('components.editor.imageActions.label', 'Image actions')}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        data-image-actions-menu=""
        onClick={(event) => event.stopPropagation()}
        onPointerDownOutside={(event) => {
          // The trigger already toggles the menu; an exiting layer must not dismiss its reopen.
          const target = event.detail.originalEvent.target
          if (target instanceof Node && triggerRef.current?.contains(target)) {
            event.preventDefault()
          }
        }}
      >
        {actions.items.map((item) => (
          <DropdownMenuItem
            key={item.label}
            disabled={actions.busy || item.disabled}
            onSelect={() => void actions.run(item.run)}
          >
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function keepImageActionsOpen(event: {
  target: EventTarget | null
  preventDefault: () => void
}): void {
  if (event.target instanceof Element && event.target.closest('[data-image-actions-menu]')) {
    event.preventDefault()
  }
}
