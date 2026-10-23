import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { FileText } from 'lucide-react'
import { ExpandableMarkdownImage } from '@/components/sidebar/MarkdownImageLightbox'
import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/CommentMarkdown'
import {
  GitHubUserAttachmentImage,
  isGitHubUserAttachmentUrl
} from '@/components/sidebar/comment-markdown-github-attachment-media'
import {
  getLocalImageCacheKey,
  getLocalImageSrcCacheKey,
  releaseLocalImageSrcByKey,
  useLocalImageSrc
} from '@/components/editor/useLocalImageSrc'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { chatImageAccess } from '@/lib/local-file-access'
import { runtimeTargetEnvironmentId } from '@/runtime/runtime-client-target'
import { basename } from '@/lib/path'
import { translate } from '@/i18n/i18n'
import type { LinkAction } from '@/components/link-actions/link-action-request'
import { jiraImageReference } from '../../../../shared/jira/jira-attachment-image'
import { filesystemPathToFileUri } from '../../../../shared/file-uri-path'
import {
  createNativeChatFileHref,
  routeNativeChatHref
} from '../../../../shared/native-chat-href-routing'
import { NativeChatMarkdownImageOwnerContext } from './native-chat-markdown-image-owner'
import { nativeChatLinkActions } from './native-chat-link-target-actions'
import { copyableNativeChatImageSrc, keepPreviewOpenForChatMenu } from './native-chat-image-copy'
import { resolveNativeChatFileLink } from './native-chat-file-link'
import { useNativeChatFileLinkClick } from './use-native-chat-file-link-click'
import { observeTranscriptVisibility } from './NativeChatTranscriptChrome'

export const NativeChatMarkdownImageLinkContext = createContext<string | undefined>(undefined)
const IMAGE_ACCESS = chatImageAccess()

type MarkdownImageProps = {
  src?: string
  alt?: string
  onLinkClick?: CommentMarkdownLinkClickHandler
}

export function NativeChatMarkdownImage(props: MarkdownImageProps): React.JSX.Element | null {
  const owner = useContext(NativeChatMarkdownImageOwnerContext)
  if (!props.src) {
    return props.alt ? <span>{props.alt}</span> : null
  }
  const src =
    props.src.startsWith('//') && /^https?:$/.test(window.location.protocol)
      ? `${window.location.protocol}${props.src}`
      : props.src
  if (isGitHubUserAttachmentUrl(props.src)) {
    return <GitHubUserAttachmentImage src={props.src} alt={props.alt} />
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

function NativeChatMarkdownImagePreview({
  src,
  alt,
  onLinkClick
}: MarkdownImageProps): React.JSX.Element {
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
  const runtimeContext = owner?.runtimeContext ?? null
  const fileLinkContext =
    runtimeContext?.worktreePath && owner?.fileLinkContext
      ? {
          ...owner.fileLinkContext,
          worktreeId: runtimeContext.worktreeId ?? owner.fileLinkContext.worktreeId,
          worktreePath: runtimeContext.worktreePath,
          runtimeEnvironmentId: runtimeTargetEnvironmentId(runtimeContext.target)
        }
      : null
  const route = routeNativeChatHref(src)
  const imageHref =
    route.kind === 'file' ? createNativeChatFileHref(route.pathText, 'literal') : src
  const target = resolveNativeChatFileLink(imageHref, fileLinkContext)
  const external = Boolean(src && /^(?:https?|data|blob):/i.test(src))
  const attachment = src ? jiraImageReference(src) !== null : false
  const visible = owner?.isVisible ?? true
  const leaseActive = visible && (near || open)
  const localSrc =
    !external && !attachment && target ? filesystemPathToFileUri(target.absolutePath) : undefined
  const loadedSrc = useLocalImageSrc(
    leaseActive ? localSrc : undefined,
    target?.absolutePath ?? '',
    runtimeContext?.connectionId,
    runtimeContext,
    IMAGE_ACCESS,
    retryKey
  )
  const releaseKey = getLocalImageSrcCacheKey(
    localSrc,
    target?.absolutePath ?? '',
    runtimeContext?.connectionId,
    runtimeContext,
    IMAGE_ACCESS
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
  useEffect(() => {
    if (!releaseKey) {
      return
    }
    if (!leaseActive) {
      releaseLocalImageSrcByKey(releaseKey)
    }
    return () => releaseLocalImageSrcByKey(releaseKey)
  }, [leaseActive, releaseKey])
  const imageSrc = external || attachment ? src : leaseActive ? loadedSrc : undefined
  const displaySrc = imageSrc === failedSrc ? undefined : imageSrc
  const onFileLinkClick = useNativeChatFileLinkClick(fileLinkContext)
  const title =
    alt?.trim() ||
    (target ? basename(target.absolutePath) : '') ||
    translate('auto.components.sidebar.MarkdownImageLightbox.image', 'Image')
  if (!visible && (open || menuOpen)) {
    setOpen(false)
    setMenuOpen(false)
  }
  const actions =
    menuOpen && fileLinkContext && imageHref
      ? nativeChatLinkActions(imageHref, fileLinkContext)
      : null
  const canOfferActions = Boolean(fileLinkContext && (target || /^https?:/i.test(src ?? '')))
  const actionsLabel = target
    ? translate('components.native-chat.imagePreview.fileActions', 'File actions')
    : translate('components.native-chat.imagePreview.linkActions', 'Link actions')
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
      {translate('components.native-chat.composer.imageUnavailable', 'Preview unavailable')}
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
        if (!nextOpen) {
          setMenuOpen(false)
        }
      }}
      triggerLabel={`${translate('components.native-chat.composer.viewAttachment', 'View image')}: ${title}`}
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
          if (route.kind === 'file') {
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
