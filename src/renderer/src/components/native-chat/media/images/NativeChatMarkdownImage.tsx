import { useNativeChatImageGallery } from './native-chat-image-gallery-context'
import { useNativeChatMarkdownImageSource } from './use-native-chat-markdown-image-source'
import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { FileText } from 'lucide-react'
import { ExpandableMarkdownImage } from '@/components/sidebar/MarkdownImageLightbox'
import {
  GitHubUserAttachmentImage,
  isGitHubUserAttachmentUrl
} from '@/components/sidebar/comment-markdown-github-attachment-media'
import { getLocalImageCacheKey } from '@/components/editor/document-images/useLocalImageSrc'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { chatImageAccess } from '@/lib/files/access/local-file-access'
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

export const NativeChatMarkdownImageLinkContext = createContext<string | undefined>(undefined)
const IMAGE_ACCESS = chatImageAccess()

type MarkdownImageProps = {
  src?: string
  alt?: string
}

export function NativeChatMarkdownImage(props: MarkdownImageProps): React.JSX.Element | null {
  const owner = useContext(NativeChatMarkdownImageOwnerContext)
  const openGallery = useNativeChatImageGallery(props.src, props.alt ?? 'Image')
  if (!props.src) {
    return props.alt ? <span>{props.alt}</span> : null
  }
  const src =
    props.src.startsWith('//') && /^https?:$/.test(window.location.protocol)
      ? `${window.location.protocol}${props.src}`
      : props.src
  if (isGitHubUserAttachmentUrl(props.src)) {
    return <GitHubUserAttachmentImage src={props.src} alt={props.alt} onPreview={openGallery} />
  }
  const identity = owner?.runtimeContext
    ? getLocalImageCacheKey(
        props.src,
        owner.runtimeContext.connectionId,
        owner.runtimeContext,
        IMAGE_ACCESS
      )
    : 'unresolved'
  return (
    <NativeChatMarkdownImagePreview
      key={[owner?.sessionId, identity, src].join('\0')}
      {...props}
      src={src}
    />
  )
}

function NativeChatMarkdownImagePreview({ src, alt }: MarkdownImageProps): React.JSX.Element {
  const t = useTranslate()
  const onLinkClick = useNativeChatLinkClick()
  const owner = useContext(NativeChatMarkdownImageOwnerContext)
  const linkedHref = useContext(NativeChatMarkdownImageLinkContext)
  const [open, setOpen] = useState(false)
  const [near, setNear] = useState(false)
  const [retryKey, setRetryKey] = useState(0)
  const [footprint, setFootprint] = useState<{ width: number; aspectRatio: string }>()
  const [loadedImageSrc, setLoadedImageSrc] = useState<string>()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [failedSrc, setFailedSrc] = useState<string>()
  const handingOff = useRef(false)
  const visible = owner?.isVisible ?? true
  const leaseActive = visible && (near || open)
  const { imageSrc, fileLinkContext, route, imageHref, target } = useNativeChatMarkdownImageSource(
    src,
    leaseActive,
    retryKey
  )
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
  const openGallery = useNativeChatImageGallery(src, title, displaySrc)
  if (!visible && (open || menuOpen)) {
    setOpen(false)
    setMenuOpen(false)
  }
  const actions =
    menuOpen && fileLinkContext && imageHref
      ? nativeChatLinkActions(imageHref, fileLinkContext, t)
      : null
  const canOfferActions = Boolean(fileLinkContext && (target || /^https?:/i.test(src ?? '')))
  const actionsLabel = target
    ? t('components.native-chat.imagePreview.fileActions', 'File actions')
    : t('components.native-chat.imagePreview.linkActions', 'Link actions')
  const runAction = (action: LinkAction): void => {
    handingOff.current = true
    flushSync(() => {
      setMenuOpen(false)
      setOpen(false)
    })
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
        if (nextOpen && openGallery) {
          openGallery()
          return
        }
        setOpen(nextOpen)
        if (!nextOpen) {
          setMenuOpen(false)
        }
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
        toolbarActions: canOfferActions ? (
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={actionsLabel}>
                    <FileText />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom">{actionsLabel}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent
              align="end"
              onCloseAutoFocus={(event) => {
                if (handingOff.current || !open) {
                  event.preventDefault()
                }
              }}
            >
              {actions
                ? [actions.primary, actions.alternate, ...(actions.secondaryActions ?? [])].map(
                    (action) =>
                      action ? (
                        <DropdownMenuItem key={action.label} onSelect={() => runAction(action)}>
                          {action.label}
                        </DropdownMenuItem>
                      ) : null
                  )
                : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null
      }}
    />
  )
}
