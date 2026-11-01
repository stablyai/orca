import { useEffect, useEffectEvent, useState } from 'react'
import {
  getLocalImageSrcCacheKey,
  loadLocalImageSrc,
  onImageCacheInvalidated,
  useLocalImageSrc
} from '@/components/editor/useLocalImageSrc'
import { translate } from '@/i18n/i18n'
import { basename } from '@/lib/path'
import { formatBytes } from '../../../../../shared/format-bytes'
import { filesystemPathToFileUri } from '../../../../../shared/file-uri-path'
import type { TerminalFileContext } from '../terminal-file-path-mapping'
import type { TerminalFilePeekContent } from './terminal-file-peek-content-types'

type ImageContent = Extract<TerminalFilePeekContent, { kind: 'image' }>

/** A thumbnail read through the owner-aware image cache; pixels are the only data this card fetches. */
export function TerminalFilePeekBodyImage({
  content,
  fileContext,
  unreadableNotice
}: {
  content: ImageContent
  fileContext: TerminalFileContext
  unreadableNotice: React.ReactNode
}): React.JSX.Element {
  // Why: an unresolved owner must refuse the read, not fall back to a local one.
  const runtimeContext = fileContext.sourceHostResolved ? fileContext : null
  const rawSrc = filesystemPathToFileUri(content.path)
  const src = useLocalImageSrc(rawSrc, content.path, undefined, runtimeContext)
  const cacheKey = getLocalImageSrcCacheKey(rawSrc, content.path, undefined, runtimeContext)
  const [failedReadKey, setFailedReadKey] = useState<string | null>(null)
  const readImage = useEffectEvent(() =>
    loadLocalImageSrc(rawSrc, content.path, undefined, runtimeContext)
  )

  useEffect(() => {
    if (!cacheKey) {
      return
    }
    let cancelled = false
    let readVersion = 0
    const observeRead = () => {
      const version = ++readVersion
      setFailedReadKey(null)
      // Share the hook's in-flight read while it owns the Blob URL lease.
      void readImage().then((url) => {
        if (!cancelled && version === readVersion) {
          setFailedReadKey(url ? null : cacheKey)
        }
      })
    }
    const unsubscribe = onImageCacheInvalidated(observeRead)
    observeRead()
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [cacheKey])
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const [loaded, setLoaded] = useState<{ src: string; width: number; height: number } | null>(null)
  const dimensions = loaded?.src === src ? loaded : null
  const caption = [
    dimensions ? `${dimensions.width} × ${dimensions.height}` : null,
    formatBytes(content.sizeBytes)
  ]
    .filter(Boolean)
    .join(' · ')

  if (!cacheKey || failedReadKey === cacheKey) {
    return <>{unreadableNotice}</>
  }
  if (src && failedSrc === src) {
    return (
      <p className="py-0.5 text-muted-foreground">
        {translate('terminal.filePeek.imageUnavailable', "This image can't be shown.")}
      </p>
    )
  }
  return (
    <div>
      {src ? (
        <img
          src={src}
          alt={basename(content.path)}
          draggable={false}
          className="max-h-60 max-w-full rounded-sm border border-border object-contain"
          onLoad={(event) =>
            setLoaded({
              src,
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight
            })
          }
          onError={() => setFailedSrc(src)}
        />
      ) : (
        <div className="h-24 rounded-sm bg-foreground/10 motion-safe:animate-pulse" />
      )}
      <p className="mt-1 text-2xs text-muted-foreground tabular-nums">{caption}</p>
    </div>
  )
}
