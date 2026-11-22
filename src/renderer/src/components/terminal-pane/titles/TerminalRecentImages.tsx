import { useCallback, useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react'
import type { Terminal } from '@xterm/xterm'
import { Image as ImageIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { useLocalImageSrc } from '@/components/editor/document-images/useLocalImageSrc'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { chatImageAccess } from '@/lib/files/access/local-file-access'
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
          onMouseDown={(event) => event.preventDefault()}
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
  const [dimensions, setDimensions] = useState<string>()
  const [fileSize, setFileSize] = useState<number>()
  const extension = image.path.slice(image.path.lastIndexOf('.') + 1).toUpperCase()
  const date = new Date(image.addedAt)
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
  return (
    <div className="flex flex-col gap-2">
      {src && (
        <img
          src={src}
          alt={name}
          className="max-h-40 w-full rounded-sm object-contain"
          onLoad={({ currentTarget }) =>
            setDimensions(`${currentTarget.naturalWidth} × ${currentTarget.naturalHeight}`)
          }
        />
      )}
      <div className="text-xs font-medium">{name}</div>
      <p className="break-all font-mono text-xs text-muted-foreground">{image.path}</p>
      <div className="flex gap-2 text-xs text-muted-foreground">
        <time dateTime={date.toISOString()}>{date.toLocaleTimeString(locale)}</time>
        <span>{extension}</span>
        {dimensions && <span>{dimensions}</span>}
        {fileSize !== undefined && <span>{formatBytes(fileSize)}</span>}
      </div>
      <div className="flex flex-wrap gap-1">
        <Button type="button" variant="ghost" size="sm" onClick={open}>
          {t('terminal.recentImages.open', 'Open preview')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          {...keepFocusPressProps}
          onClick={() => void window.api.ui.writeClipboardText(image.path)}
        >
          {t('terminal.recentImages.copyPath', 'Copy path')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          {...keepFocusPressProps}
          onClick={() => void revealInFileManager(image.path, getLocalPathOpenOwnerForRoute({}))}
        >
          {getRevealInFileManagerLabel(t)}
        </Button>
      </div>
    </div>
  )
}
