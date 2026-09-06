import { useState } from 'react'
import { Globe } from 'lucide-react'
import { cn } from '@/lib/utils'
import { displayableFaviconUrl } from './browser-pane/describe-page/browser-favicon-url'

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
  const displayUrl = displayableFaviconUrl(faviconUrl)
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const [previousLoading, setPreviousLoading] = useState(loading)

  // Retry after navigation settles, when cookies and connectivity may have recovered.
  if (previousLoading !== loading) {
    setPreviousLoading(loading)
    if (!loading) {
      setFailedUrl(null)
    }
  }

  // Why: reset during render on any favicon identity change — including a clear to null while
  // a page loads — so navigating back to the same url retries instead of keeping the fallback.
  if (failedUrl !== null && failedUrl !== displayUrl) {
    setFailedUrl(null)
  }

  if (displayUrl && failedUrl !== displayUrl) {
    return (
      <img
        src={displayUrl}
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
        onError={() => setFailedUrl(displayUrl)}
      />
    )
  }

  return <Globe className={cn('shrink-0', className, fallbackClassName)} aria-hidden="true" />
}
