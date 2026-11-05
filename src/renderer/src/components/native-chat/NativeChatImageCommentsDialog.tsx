import { ImageCommentTool } from './ImageCommentTool'
import { ImageCommentSidebar } from './ImageCommentSidebar'
import { useEffect, useRef, useState } from 'react'
import { ImageCommentCanvas } from './ImageCommentCanvas'
import { Loader2, Maximize, MessageSquarePlus, X, ZoomIn, ZoomOut } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogHeader
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { PanZoomImageSurface } from '@/components/editor/PanZoomImageSurface'
import { usePanZoomViewport } from '@/components/editor/use-pan-zoom-viewport'
import { renderImagePngDataUrl } from '@/components/editor/image-png-export'
import {
  imageCommentsText,
  paintImageCommentPins,
  type ImageCommentPin
} from './image-comment-pins'
import type { NativeChatCopyImage } from './native-chat-image-copy'
import type { PanZoomSize } from '../../../../shared/pan-zoom-view'
import { isMacPlatform } from './native-chat-shortcut'

export type NativeChatImageCommentsDialogProps = {
  image: NativeChatCopyImage
  title: string
  onClose: () => void
  onDone: (dataUrl: string, text: string) => Promise<void>
}

export function NativeChatImageCommentsDialog({
  image,
  title,
  onClose,
  onDone
}: NativeChatImageCommentsDialogProps): React.JSX.Element {
  const [src, setSrc] = useState<string | null>(null)
  const [size, setSize] = useState<PanZoomSize | null>(null)
  const [pins, setPins] = useState<ImageCommentPin[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const panZoom = usePanZoomViewport({ content: size })
  const valid = pins.length > 0 && pins.every((item) => item.comment.trim())
  useEffect(() => {
    let active = true
    let url: string | undefined
    void image()
      .then((blob) => {
        if (active) {
          url = URL.createObjectURL(blob)
          setSrc(url)
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      })
    return () => {
      active = false
      if (url) {
        URL.revokeObjectURL(url)
      }
    }
  }, [image])
  const close = (): void => {
    if (saving) {
      return
    }
    if (pins.length) {
      setDiscarding(true)
    } else {
      onClose()
    }
  }
  const done = async (): Promise<void> => {
    if (!src || !size || !valid || saving) {
      return
    }
    setSaving(true)
    setError(null)
    try {
      const dataUrl = await renderImagePngDataUrl(src, size, null, (context, layout) => {
        const ratio = layout.width / size.width
        paintImageCommentPins(context, size, pins, ratio)
      })
      await onDone(dataUrl, imageCommentsText(title, size, pins))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setSaving(false)
    }
  }

  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) {
            close()
          }
        }}
      >
        <DialogContent
          showCloseButton={false}
          aria-describedby={undefined}
          className="flex h-[90dvh] w-[90vw] max-w-[90vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[90vw]"
          onEscapeKeyDown={(event) => {
            event.preventDefault()
            close()
          }}
          onPointerDownOutside={(event) => event.preventDefault()}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            ;(event.currentTarget as HTMLElement).focus()
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (isMacPlatform() ? event.metaKey : event.ctrlKey)) {
              event.preventDefault()
              void done()
            }
          }}
        >
          <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
            <div className="min-w-0 flex-1">
              <DialogTitle>
                {translate('components.native-chat.imageComments.title', 'Image comments')}
              </DialogTitle>
              <p className="truncate text-xs text-muted-foreground">{title}</p>
            </div>
            <ImageCommentTool
              label={translate('components.native-chat.imageComments.add', 'Add comment')}
              disabled={!size || saving || pins.length >= 99}
              onClick={() => {
                const id = createBrowserUuid()
                setPins((items) => [...items, { id, x: 50, y: 50, comment: '' }])
                setSelected(id)
                requestAnimationFrame(() => editorRef.current?.focus())
              }}
            >
              <MessageSquarePlus />
            </ImageCommentTool>
            <ImageCommentTool
              label={translate('auto.components.editor.PanZoomImageDialog.zoomOut', 'Zoom out')}
              disabled={!panZoom.canZoomOut}
              onClick={() => panZoom.zoomBy(1 / 1.25)}
            >
              <ZoomOut />
            </ImageCommentTool>
            <ImageCommentTool
              label={translate('auto.components.editor.PanZoomImageDialog.zoomIn', 'Zoom in')}
              disabled={!panZoom.canZoomIn}
              onClick={() => panZoom.zoomBy(1.25)}
            >
              <ZoomIn />
            </ImageCommentTool>
            <ImageCommentTool
              label={translate('auto.components.editor.PanZoomImageDialog.fit', 'Fit to screen')}
              onClick={panZoom.fit}
            >
              <Maximize />
            </ImageCommentTool>
            <Button disabled={!size || !valid || saving} onClick={() => void done()}>
              {saving ? (
                <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
              ) : null}
              {translate('components.native-chat.imageComments.done', 'Done')}
            </Button>
            <ImageCommentTool
              label={translate('auto.components.editor.PanZoomImageDialog.close', 'Close')}
              disabled={saving}
              onClick={close}
            >
              <X />
            </ImageCommentTool>
          </header>
          <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
            <div className="relative min-h-48 min-w-0 flex-1">
              <PanZoomImageSurface
                panZoom={panZoom}
                src={src}
                alt={title}
                content={size}
                className="absolute inset-0 bg-muted/30"
                onLoad={(event) =>
                  setSize({
                    width: event.currentTarget.naturalWidth,
                    height: event.currentTarget.naturalHeight
                  })
                }
                onError={() =>
                  setError(
                    translate(
                      'components.native-chat.imageComments.loadFailed',
                      'This image could not be loaded.'
                    )
                  )
                }
                fallback={<Loader2 className="size-5 animate-spin motion-reduce:animate-none" />}
              >
                <ImageCommentCanvas
                  size={size}
                  panZoom={panZoom}
                  pins={pins}
                  setPins={setPins}
                  selected={selected}
                  setSelected={setSelected}
                  saving={saving}
                  editorRef={editorRef}
                />
              </PanZoomImageSurface>
            </div>
            <ImageCommentSidebar
              pins={pins}
              selected={selected}
              setPins={setPins}
              setSelected={setSelected}
              saving={saving}
              editorRef={editorRef}
            />
          </div>
          {error ? (
            <div
              role="alert"
              className="shrink-0 border-t border-border p-3 text-sm text-destructive"
            >
              {error}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
      <Dialog open={discarding} onOpenChange={setDiscarding}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {translate(
                'components.native-chat.imageComments.discardTitle',
                'Discard image comments?'
              )}
            </DialogTitle>
            <DialogDescription>
              {translate(
                'components.native-chat.imageComments.discardDescription',
                'These comments have not been added to your chat draft.'
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDiscarding(false)}>
              {translate('common.cancel', 'Cancel')}
            </Button>
            <Button onClick={onClose}>{translate('common.discard', 'Discard')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
