import { useState } from 'react'
import { Globe, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { normalizeBrowserFaviconUrl } from '../../../shared/browser-favicon-url'

type BrowserFaviconClasses = {
  className?: string
  fallbackClassName?: string
}

function FaviconFallback({
  className,
  fallbackClassName
}: BrowserFaviconClasses): React.JSX.Element {
  return <Globe className={cn('shrink-0', className, fallbackClassName)} aria-hidden="true" />
}

function FaviconImage({
  src,
  className,
  fallbackClassName
}: BrowserFaviconClasses & { src: string }): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return <FaviconFallback className={className} fallbackClassName={fallbackClassName} />
  }
  return (
    <img
      src={src}
      alt=""
      aria-hidden
      draggable={false}
      decoding="async"
      loading="lazy"
      fetchPriority="low"
      className={cn(
        'shrink-0 rounded-sm object-contain drop-shadow-[0_0_1px_var(--foreground)]',
        className
      )}
      onError={() => setFailed(true)}
    />
  )
}

export function BrowserFavicon({
  faviconUrl,
  loading = false,
  className,
  fallbackClassName
}: {
  faviconUrl: string | null | undefined
  loading?: boolean
  className?: string
  fallbackClassName?: string
}): React.JSX.Element {
  if (loading) {
    return (
      <Loader2
        className={cn('shrink-0 motion-safe:animate-spin', className, fallbackClassName)}
        aria-hidden="true"
      />
    )
  }
  const displayUrl = normalizeBrowserFaviconUrl(faviconUrl)
  return displayUrl ? (
    <FaviconImage
      key={displayUrl}
      src={displayUrl}
      className={className}
      fallbackClassName={fallbackClassName}
    />
  ) : (
    <FaviconFallback className={className} fallbackClassName={fallbackClassName} />
  )
}
