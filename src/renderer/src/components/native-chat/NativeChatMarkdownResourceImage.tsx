import { cn } from '@/lib/utils'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { PanZoomImageDialog } from '@/components/editor/PanZoomImageDialog'
import {
  acquireLocalImageSrcLease,
  getLocalImageCacheKey,
  loadLocalImageAbsolutePath,
  onImageCacheInvalidated,
  releaseLocalImageSrcByKey
} from '@/components/editor/useLocalImageSrc'
import {
  HostFileRefusal,
  resolveHostWorkspaceFile
} from '@/components/terminal-pane/terminal-host-workspace-file'
import { chatImageAccess } from '@/lib/local-file-access'
import { readIpcErrorMessage } from '@/lib/ipc-error'
import { translate } from '@/i18n/i18n'
import { createNativeChatFileHref } from '../../../../shared/native-chat-href-routing'
import { useNativeChatResourceOwner } from './NativeChatResourceOwner'
import { observeTranscriptVisibility } from './native-chat-transcript-visibility'
import { copyableNativeChatImageSrc, keepPreviewOpenForChatMenu } from './native-chat-image-copy'
import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/CommentMarkdown'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { filesystemPathToFileUri } from '../../../../shared/file-uri-path'

type ImageState = { identity: string; src?: string; error?: string }

/** Uses the transcript image cache and host grants, never a file: URL in the renderer. */
export function NativeChatMarkdownResourceImage({
  path,
  alt,
  compact = false,
  onLinkClick
}: {
  path: string
  alt: string
  compact?: boolean
  onLinkClick?: CommentMarkdownLinkClickHandler
}): React.JSX.Element {
  const owner = useNativeChatResourceOwner()
  const context = owner?.runtimeContext
  const identity = JSON.stringify([path, owner])
  const [state, setState] = useState<ImageState>({ identity: '' })
  const [near, setNear] = useState(false)
  const [generation, setGeneration] = useState(0)
  useEffect(() => onImageCacheInvalidated(() => setGeneration((value) => value + 1)), [])
  const [openIdentity, setOpenIdentity] = useState<string | null>(null)
  const open = openIdentity === identity
  const ref = useRef<HTMLSpanElement>(null)
  const readOwner = useEffectEvent(() => owner)
  useEffect(
    () =>
      ref.current
        ? observeTranscriptVisibility(ref.current, (visible) => {
            if (visible) {
              setNear(true)
            }
          })
        : undefined,
    []
  )
  useEffect(() => {
    const capturedOwner = readOwner()
    const context = capturedOwner?.runtimeContext
    if (!near || !context || !capturedOwner) {
      return
    }
    let canceled = false
    let release: (() => void) | undefined
    let key: string | null = null
    void (async () => {
      const resolved = await resolveHostWorkspaceFile(
        context,
        path,
        undefined,
        capturedOwner.nativeChatContext
      )
      if (canceled) {
        return
      }
      const filePath = resolved?.kind === 'client' ? null : (resolved?.absolutePath ?? path)
      if (!filePath) {
        throw new Error(
          translate(
            'components.native-chat.fileLinks.imageFileUnavailable',
            'The file is not available on its session host'
          )
        )
      }
      const readContext =
        resolved?.kind === 'grant'
          ? { ...context, terminalArtifactGrantId: resolved.grantId }
          : resolved?.kind === 'host'
            ? { ...context, worktreeId: resolved.worktreeId, worktreePath: resolved.worktreePath }
            : context
      key = getLocalImageCacheKey(filePath, undefined, readContext, chatImageAccess())
      release = acquireLocalImageSrcLease(
        filesystemPathToFileUri(filePath),
        filePath,
        undefined,
        readContext,
        chatImageAccess()
      )
      const src = await loadLocalImageAbsolutePath(
        filePath,
        undefined,
        readContext,
        chatImageAccess()
      )
      if (!canceled) {
        setState({
          identity,
          ...(src
            ? { src }
            : {
                error: translate(
                  'components.native-chat.fileLinks.imagePreviewUnavailable',
                  'The host could not provide an image preview'
                )
              })
        })
      }
    })().catch((error: unknown) => {
      if (!canceled) {
        setState({
          identity,
          error:
            error instanceof HostFileRefusal
              ? translate(
                  'components.native-chat.fileLinks.imageFileUnavailable',
                  'The file is not available on its session host'
                )
              : error instanceof RuntimeRpcCallError &&
                  (error.code === 'method_not_found' || error.code === 'invalid_params')
                ? translate(
                    'components.native-chat.fileLinks.imageServerUpdateRequired',
                    'Update the Orca server to preview this chat file'
                  )
                : (readIpcErrorMessage(error) ?? String(error))
        })
      }
    })
    return () => {
      canceled = true
      release?.()
      if (key) {
        releaseLocalImageSrcByKey(key)
      }
    }
  }, [identity, near, path, generation])
  const current = state.identity === identity ? state : null
  const error = !context
    ? translate(
        'components.native-chat.fileLinks.imageHostUnavailable',
        'The session host is unavailable'
      )
    : current?.error
  const label = alt || path
  return (
    <span ref={ref} className="inline-block max-w-full">
      {current?.src && !error ? (
        <>
          <button
            type="button"
            onClick={() => setOpenIdentity(identity)}
            aria-label={label}
            data-native-chat-copy-image-src={copyableNativeChatImageSrc(current.src)}
            className={cn(
              'max-w-full rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              compact &&
                'size-20 overflow-hidden border border-border bg-chat-canvas transition-colors hover:border-ring'
            )}
          >
            <img
              src={current.src}
              alt={alt}
              className={
                compact
                  ? 'size-full object-cover'
                  : 'my-3 max-h-96 max-w-full rounded-md object-contain'
              }
              onError={() =>
                setState({
                  identity,
                  error: translate(
                    'components.native-chat.fileLinks.imageDisplayFailed',
                    'The image could not be displayed'
                  )
                })
              }
            />
          </button>
          <PanZoomImageDialog
            open={open}
            onOpenChange={(nextOpen) => setOpenIdentity(nextOpen ? identity : null)}
            src={current.src}
            title={label}
            showTitle
            data-native-chat-copy-image-src={copyableNativeChatImageSrc(current.src)}
            onInteractOutside={keepPreviewOpenForChatMenu}
          />
        </>
      ) : (
        <span role="status">
          {error
            ? translate(
                'components.native-chat.fileLinks.imageUnavailable',
                "Couldn't preview image: {{value0}}",
                { value0: error }
              )
            : translate('components.native-chat.fileLinks.imageLoading', 'Loading image…')}{' '}
          <a
            href={createNativeChatFileHref(path, 'sandbox')}
            onClick={(event) => {
              event.preventDefault()
              onLinkClick?.(event, createNativeChatFileHref(path, 'sandbox'))
            }}
            className="text-primary underline underline-offset-2"
          >
            {label}
          </a>
        </span>
      )}
    </span>
  )
}
