import { useContext, useRef } from 'react'
import { flushSync } from 'react-dom'
import { Image as ImageIcon } from 'lucide-react'
import { PanZoomImageDialog } from '@/components/editor/PanZoomImageDialog'
import { basename } from '@/lib/path'
import { useTranslate } from '@/i18n/use-translate'
import type { LinkAction } from '@/components/link-actions/link-action-request'
import { NativeChatMarkdownImageOwnerContext } from '../images/native-chat-markdown-image-owner'
import { useNativeChatTranscriptImageSrc } from '../images/use-native-chat-transcript-image-src'
import {
  nativeChatMarkdownImageDisplaySrc,
  useNativeChatMarkdownImageSrc
} from '../images/use-native-chat-markdown-image-src'
import { NativeChatImageLinkActions } from '../images/NativeChatImageLinkActions'
import { nativeChatImageLabel } from '../images/native-chat-image-label'
import {
  copyableNativeChatImageSrc,
  keepPreviewOpenForChatMenu
} from '../images/native-chat-image-copy'
import type { NativeChatGalleryImage } from './native-chat-gallery-images'

/** One preview for the whole chat; it resolves whichever image is current, mounted row or not. */
export function NativeChatImageGalleryDialog({
  images,
  index,
  open,
  retryKey,
  onOpenChange,
  onSelect
}: {
  images: readonly NativeChatGalleryImage[]
  index: number
  open: boolean
  /** Per opening, so a failed load retries like a freshly opened thumbnail. */
  retryKey: number
  onOpenChange: (open: boolean) => void
  onSelect: (key: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const owner = useContext(NativeChatMarkdownImageOwnerContext)
  const handingOff = useRef(false)
  const image = images[index]
  const active = open && (owner?.isVisible ?? true)
  const markdownSrc =
    image?.kind === 'markdown' ? nativeChatMarkdownImageDisplaySrc(image.source) : undefined
  const markdown = useNativeChatMarkdownImageSrc({
    src: markdownSrc,
    active: active && markdownSrc !== undefined,
    retryKey
  })
  const attachmentBlock = image?.kind === 'attachment' ? image.block : undefined
  const attachment = useNativeChatTranscriptImageSrc(
    attachmentBlock,
    owner?.runtimeContext,
    active && attachmentBlock !== undefined
  )
  const displaySrc = attachmentBlock ? attachment.displaySrc : markdown.imageSrc
  const label = attachmentBlock
    ? nativeChatImageLabel(attachmentBlock)
    : (image?.kind === 'markdown' ? image.alt?.trim() : '') ||
      (markdown.target ? basename(markdown.target.absolutePath) : '') ||
      t('auto.components.sidebar.MarkdownImageLightbox.image', 'Image')
  const previous = images[index - 1]
  const next = images[index + 1]
  const runAction = (action: LinkAction): void => {
    handingOff.current = true
    flushSync(() => onOpenChange(false))
    void action.run()
  }
  const fallback = attachmentBlock ? (
    <div className="flex max-w-full items-center gap-1.5 rounded-md border border-border bg-chat-canvas px-2 py-1 text-xs text-chat-foreground-faint">
      <ImageIcon className="size-3.5 shrink-0" />
      <span className="truncate">{label}</span>
    </div>
  ) : (
    <span role="status" className="text-sm text-muted-foreground">
      {t('components.native-chat.composer.imageUnavailable', 'Preview unavailable')}
    </span>
  )

  return (
    <PanZoomImageDialog
      open={open && image !== undefined}
      onOpenChange={onOpenChange}
      src={displaySrc}
      title={label}
      showTitle
      fallback={fallback}
      contentKey={image?.key}
      data-native-chat-copy-image-src={copyableNativeChatImageSrc(displaySrc)}
      data-native-chat-image-gallery
      onInteractOutside={keepPreviewOpenForChatMenu}
      onCloseAutoFocus={(event) => {
        if (handingOff.current) {
          event.preventDefault()
        }
      }}
      navigation={{
        position: index + 1,
        count: images.length,
        onPrevious: previous ? () => onSelect(previous.key) : undefined,
        onNext: next ? () => onSelect(next.key) : undefined
      }}
      toolbarActions={
        markdownSrc !== undefined ? (
          <NativeChatImageLinkActions
            key={image?.key}
            src={markdownSrc}
            image={markdown}
            dialogOpen={open}
            isHandingOff={() => handingOff.current}
            onRun={runAction}
          />
        ) : null
      }
    />
  )
}
