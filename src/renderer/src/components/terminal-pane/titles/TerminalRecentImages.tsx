import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import type { Terminal } from '@xterm/xterm'
import { Check, Copy, FolderOpen, Image as ImageIcon, Maximize2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/class-names'
import {
  loadLocalImageAbsolutePath,
  useLocalImageSrc
} from '@/components/editor/document-images/useLocalImageSrc'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { chatImageAccess } from '@/lib/files/access/local-file-access'
import { WORKSPACE_FILE_PATH_MIME } from '@/lib/files/drop/workspace-file-drag'
import { writeWorkspaceFileDragSourceForWorkspace } from '@/lib/files/drop/workspace-file-drag-source'
import { getLocalPathOpenOwnerForRoute } from '@/lib/files/os-open/local-path-open-guard'
import {
  getRevealInFileManagerLabel,
  revealInFileManager
} from '@/lib/files/os-open/reveal-in-file-manager'
import { keepFocusPressProps } from '@/lib/overlay-interaction/focus-keeping-press'
import { basename } from '@/lib/path'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import { filesystemPathToFileUri } from '../../../../../shared/file-links/file-uri-path'
import { formatBytes } from '../../../../../shared/text/format-bytes'
import { openDetectedFilePath } from '../links/files/terminal-file-open-routing'
import {
  getRecentTerminalImages,
  subscribeToRecentTerminalImages,
  type RecentTerminalImage
} from '../input/recent-terminal-images'

type ImageLocation = { worktreeId: string; worktreePath: string; sourceTabId: string }

export function TerminalPaneRecentImages({
  pane,
  enabled,
  renderHeader,
  ...location
}: ImageLocation & {
  pane: ManagedPane
  enabled: boolean
  renderHeader: (chips: React.JSX.Element | null) => React.JSX.Element | null
}): React.JSX.Element | null {
  const { terminal, container } = pane
  const subscribe = useCallback(
    (listener: () => void) => subscribeToRecentTerminalImages(terminal, listener),
    [terminal]
  )
  const getSnapshot = useCallback(() => getRecentTerminalImages(terminal), [terminal])
  const images = useSyncExternalStore(subscribe, getSnapshot)
  const showImages = enabled && images.length > 0
  // Keep the grid inset when the visible tab group loses focus and hides its header controls.
  useLayoutEffect(() => {
    if (!showImages) {
      return
    }
    container.setAttribute('data-has-recent-images', '')
    return () => container.removeAttribute('data-has-recent-images')
  }, [container, showImages])
  const chips = showImages ? (
    <div className="pane-title-recent-images scrollbar-none ml-auto flex min-w-0 items-center gap-1 self-center overflow-x-auto rounded-md bg-(--orca-pane-title-bg)">
      {images.map((item) => (
        <TerminalImageChip key={item.path} image={item} terminal={terminal} location={location} />
      ))}
    </div>
  ) : null
  return renderHeader(chips)
}

function TerminalImageChip({
  image,
  terminal,
  location
}: {
  image: RecentTerminalImage
  terminal: Terminal
  location: ImageLocation
}): React.JSX.Element {
  const t = useTranslate()
  const name = image.pasted
    ? t('terminal.recentImages.pasted', 'Pasted image')
    : basename(image.path)
  const open = (): void => openDetectedFilePath(image.path, null, null, location)
  const [previewOpen, setPreviewOpen] = useState(false)
  useEffect(() => {
    if (!previewOpen) {
      return
    }
    const subscription = terminal.onScroll(() => setPreviewOpen(false))
    return () => subscription.dispose()
  }, [previewOpen, terminal])
  return (
    <HoverCard open={previewOpen} onOpenChange={setPreviewOpen} openDelay={500} closeDelay={200}>
      <HoverCardTrigger asChild>
        <Button
          type="button"
          variant="muted-field-icon"
          size="xs"
          className="min-w-0 max-w-32"
          draggable
          onPointerEnter={() => {
            void loadLocalImageAbsolutePath(image.path, null, undefined, chatImageAccess())
          }}
          onDragStart={(event) => {
            setPreviewOpen(false)
            event.dataTransfer.setData(WORKSPACE_FILE_PATH_MIME, image.path)
            writeWorkspaceFileDragSourceForWorkspace(event.dataTransfer, location.worktreeId)
            event.dataTransfer.effectAllowed = 'copy'
          }}
          onClick={open}
        >
          <ImageIcon className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{name}</span>
        </Button>
      </HoverCardTrigger>
      <HoverCardContent side="bottom" align="end" variant="row-details">
        <TerminalImagePreview image={image} name={name} open={open} />
      </HoverCardContent>
    </HoverCard>
  )
}

function TerminalImagePreview({
  image,
  name,
  open
}: {
  image: RecentTerminalImage
  name: string
  open: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const src = useLocalImageSrc(
    filesystemPathToFileUri(image.path),
    image.path,
    null,
    undefined,
    chatImageAccess()
  )
  const [loadedImage, setLoadedImage] = useState<{ src: string; dimensions: string }>()
  const [fileSize, setFileSize] = useState<number>()
  const [copied, setCopied] = useState(false)
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isImageReady = Boolean(src && loadedImage?.src === src)
  const dimensions = src && loadedImage?.src === src ? loadedImage.dimensions : undefined
  const dotIndex = image.path.lastIndexOf('.')
  const extension = dotIndex > 0 ? image.path.slice(dotIndex + 1).toUpperCase() : ''
  const date = new Date(image.addedAt)
  const timeLabel = date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
  const copyLabel = t('terminal.recentImages.copyPath', 'Copy path')
  const revealLabel = getRevealInFileManagerLabel(t)

  useEffect(() => {
    let cancelled = false
    void window.api.fs
      .stat({ filePath: image.path, access: chatImageAccess(), wakeWslDistro: false })
      .then(({ size }) => {
        if (!cancelled) {
          setFileSize(size)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [image.path])

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) {
        clearTimeout(copiedTimerRef.current)
      }
    }
  }, [])

  const handleCopyPath = (): void => {
    void window.api.ui.writeClipboardText(image.path).then(
      () => {
        setCopied(true)
        if (copiedTimerRef.current !== null) {
          clearTimeout(copiedTimerRef.current)
        }
        copiedTimerRef.current = setTimeout(() => {
          copiedTimerRef.current = null
          setCopied(false)
        }, 1500)
      },
      () => {}
    )
  }

  const metaItems: { key: string; node: React.ReactNode }[] = []
  if (extension) {
    metaItems.push({ key: 'ext', node: extension })
  }
  if (dimensions) {
    metaItems.push({ key: 'dims', node: dimensions })
  }
  if (fileSize !== undefined) {
    metaItems.push({ key: 'size', node: formatBytes(fileSize) })
  }
  metaItems.push({
    key: 'time',
    node: <time dateTime={date.toISOString()}>{timeLabel}</time>
  })

  return (
    <div className="flex flex-col gap-2">
      <div className="relative flex h-36 w-full items-center justify-center overflow-hidden rounded-sm border border-border bg-muted/40">
        {!isImageReady && (
          <div
            aria-hidden
            className="absolute inset-0 flex items-center justify-center bg-muted/60 animate-pulse motion-reduce:animate-none"
          >
            <ImageIcon className="size-5 text-muted-foreground/35" />
          </div>
        )}
        {src && (
          <img
            src={src}
            alt={name}
            className={cn(
              'max-h-full max-w-full object-contain transition-opacity duration-150 motion-reduce:transition-none',
              isImageReady ? 'opacity-100' : 'opacity-0'
            )}
            onLoad={({ currentTarget }) =>
              setLoadedImage({
                src,
                dimensions: `${currentTarget.naturalWidth} × ${currentTarget.naturalHeight}`
              })
            }
          />
        )}
      </div>

      <div className="flex flex-col gap-0.5 px-0.5">
        <div className="truncate text-xs font-medium text-popover-foreground" title={name}>
          {name}
        </div>
        <div className="flex h-4 items-center gap-1 truncate text-2xs text-muted-foreground tabular-nums">
          {metaItems.map((item, index) => (
            <Fragment key={item.key}>
              {index > 0 && (
                <span aria-hidden className="opacity-45">
                  ·
                </span>
              )}
              <span>{item.node}</span>
            </Fragment>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between gap-1 border-t border-border pt-2">
        <Button type="button" variant="secondary" size="xs" onClick={open}>
          <Maximize2 className="size-3" aria-hidden />
          {t('terminal.recentImages.open', 'Open preview')}
        </Button>
        <div className="flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="muted-field-icon"
                size="icon-xs"
                aria-label={copyLabel}
                {...keepFocusPressProps}
                onClick={handleCopyPath}
              >
                {copied ? (
                  <Check className="size-3.5 text-status-success" aria-hidden />
                ) : (
                  <Copy className="size-3.5" aria-hidden />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {copied ? t('terminal.recentImages.copied', 'Copied') : copyLabel}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="muted-field-icon"
                size="icon-xs"
                aria-label={revealLabel}
                {...keepFocusPressProps}
                onClick={() =>
                  void revealInFileManager(image.path, getLocalPathOpenOwnerForRoute({}))
                }
              >
                <FolderOpen className="size-3.5" aria-hidden />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {revealLabel}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  )
}
