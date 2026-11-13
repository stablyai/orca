import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { ExpandableMarkdownImage } from '@/components/sidebar/MarkdownImageLightbox'
import {
  GitHubUserAttachmentImage,
  isGitHubUserAttachmentUrl
} from '@/components/sidebar/comment-markdown-github-attachment-media'
import { getLocalImageCacheKey } from '@/components/editor/document-images/useLocalImageSrc'
import { basename } from '@/lib/path'
import { useTranslate } from '@/i18n/use-translate'
import type { LinkAction } from '@/components/link-actions/link-action-request'
import { routeNativeChatHref } from '../../../../../../shared/native-chat/native-chat-href-routing'
import { NativeChatMarkdownImageOwnerContext } from './native-chat-markdown-image-owner'
import { nativeChatLinkActions } from '../../links/actions/native-chat-link-target-actions'
import { copyableNativeChatImageSrc, keepPreviewOpenForChatMenu } from './native-chat-image-copy'
import { useNativeChatFileLinkClick } from '../../links/actions/use-native-chat-file-link-click'
import { observeTranscriptVisibility } from './native-chat-image-visibility'
import { useNativeChatLinkClick } from '../../links/actions/native-chat-link-click-context'
import {
  NATIVE_CHAT_MARKDOWN_IMAGE_ACCESS,
  nativeChatMarkdownImageDisplaySrc,
  useNativeChatMarkdownImageSrc
} from './use-native-chat-markdown-image-src'
import { NativeChatImageLinkActions } from './NativeChatImageLinkActions'
import { NativeChatImageGalleryContext } from '../gallery/native-chat-image-gallery-context'
import { NativeChatMarkdownRowKeyContext } from '../../markdown/native-chat-markdown-row-identity'

export const NativeChatMarkdownImageLinkContext = createContext<string | undefined>(undefined)

type MarkdownImageProps = {
  src?: string
  alt?: string
}

export function NativeChatMarkdownImage(props: MarkdownImageProps): React.JSX.Element | null {
  const owner = useContext(NativeChatMarkdownImageOwnerContext)
  if (!props.src) {
    return props.alt ? <span>{props.alt}</span> : null
  }
  if (isGitHubUserAttachmentUrl(props.src)) {
    return <GitHubUserAttachmentImage src={props.src} alt={props.alt} />
  }
  const src = nativeChatMarkdownImageDisplaySrc(props.src)
  const identity = owner?.runtimeContext
    ? getLocalImageCacheKey(
        props.src,
        owner.runtimeContext.connectionId,
        owner.runtimeContext,
        NATIVE_CHAT_MARKDOWN_IMAGE_ACCESS
      )
    : 'unresolved'
  return (
    <NativeChatMarkdownImagePreview
      key={[owner?.sessionId, identity, src].join('\0')}
      alt={props.alt}
      src={src}
      gallerySource={props.src}
    />
  )
}

function NativeChatMarkdownImagePreview({
  src,
  alt,
  gallerySource
}: {
  src: string
  alt?: string
  /** The source as the transcript wrote it, which the chat-wide preview indexes by. */
  gallerySource: string
}): React.JSX.Element {
  const t = useTranslate()
  const onLinkClick = useNativeChatLinkClick()
  const owner = useContext(NativeChatMarkdownImageOwnerContext)
  const linkedHref = useContext(NativeChatMarkdownImageLinkContext)
  const gallery = useContext(NativeChatImageGalleryContext)
  const rowKey = useContext(NativeChatMarkdownRowKeyContext)
  const [open, setOpen] = useState(false)
  const [near, setNear] = useState(false)
  const [retryKey, setRetryKey] = useState(0)
  const [footprint, setFootprint] = useState<{ width: number; aspectRatio: string }>()
  const [loadedImageSrc, setLoadedImageSrc] = useState<string>()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [failedSrc, setFailedSrc] = useState<string>()
  const handingOff = useRef(false)
  const visible = owner?.isVisible ?? true
  const leaseActive = visible && (near || open)
  const image = useNativeChatMarkdownImageSrc({ src, active: leaseActive, retryKey })
  const { imageSrc, imageHref, target, route, fileLinkContext } = image
  useEffect(() => {
    const element = triggerRef.current
    if (!element) {
      return
    }
    return observeTranscriptVisibility(element, (nextNear) => {
      if (!nextNear) {
        const { width, height } = element.getBoundingClientRect()
        if (width > 0 && height > 0) {
          setFootprint({ width, aspectRatio: `${width} / ${height}` })
        }
      }
      setNear(nextNear)
    })
  }, [])
  const displaySrc = imageSrc === failedSrc ? undefined : imageSrc
  const onFileLinkClick = useNativeChatFileLinkClick(fileLinkContext)
  const title =
    alt?.trim() ||
    (target ? basename(target.absolutePath) : '') ||
    t('auto.components.sidebar.MarkdownImageLightbox.image', 'Image')
  if (!visible && open) {
    setOpen(false)
  }
  const runAction = (action: LinkAction): void => {
    handingOff.current = true
    flushSync(() => setOpen(false))
    void action.run()
  }
  const fallback = (
    <span role="status" className="text-sm text-muted-foreground">
      {t('components.native-chat.composer.imageUnavailable', 'Preview unavailable')}
    </span>
  )
  const copyAttributes = {
    'data-native-chat-copy-image-src': copyableNativeChatImageSrc(displaySrc)
  }

  return (
    <ExpandableMarkdownImage
      src={displaySrc}
      alt={title}
      open={open && visible}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          handingOff.current = false
          setRetryKey((key) => key + 1)
        }
        setOpen(nextOpen)
      }}
      triggerLabel={`${t('components.native-chat.composer.viewAttachment', 'View image')}: ${title}`}
      className="max-h-96 max-w-full rounded-md object-contain outline outline-1 outline-border/70"
      onError={() => setFailedSrc(imageSrc)}
      onLoad={() => {
        const bounds = triggerRef.current?.getBoundingClientRect()
        if (bounds && bounds.width > 0 && bounds.height > 0) {
          setFootprint({ width: bounds.width, aspectRatio: `${bounds.width} / ${bounds.height}` })
        }
        setLoadedImageSrc(displaySrc)
      }}
      triggerAttributes={copyAttributes}
      triggerRef={triggerRef}
      triggerStyle={displaySrc && displaySrc === loadedImageSrc ? undefined : footprint}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
          if (route.kind === 'file' && imageHref) {
            onFileLinkClick?.(event, imageHref)
          } else {
            onLinkClick?.(event, src)
          }
          event.preventDefault()
        } else if (gallery?.open(gallerySource, rowKey)) {
          event.preventDefault()
        }
      }}
      onAuxClick={(event) => {
        if (event.button === 1 && linkedHref) {
          event.stopPropagation()
          const linkedRoute = routeNativeChatHref(linkedHref)
          if (linkedRoute.kind === 'web' && /^https?:/i.test(linkedRoute.url)) {
            event.preventDefault()
            const actions = nativeChatLinkActions(linkedHref, fileLinkContext)
            if (actions) {
              void actions.primary.run()
            } else {
              window.open(linkedRoute.url, '_blank', 'noopener,noreferrer')
            }
          } else {
            onLinkClick?.(event, linkedHref)
          }
        }
      }}
      dialogProps={{
        fallback,
        onCloseAutoFocus: (event) => {
          if (handingOff.current) {
            event.preventDefault()
          }
        },
        onInteractOutside: keepPreviewOpenForChatMenu,
        ...copyAttributes,
        toolbarActions: (
          <NativeChatImageLinkActions
            src={src}
            image={image}
            dialogOpen={open}
            isHandingOff={() => handingOff.current}
            onRun={runAction}
          />
        )
      }}
    />
  )
}
