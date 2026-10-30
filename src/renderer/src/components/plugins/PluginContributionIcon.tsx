import { createElement, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { parsePluginImageUrl } from '../../../../shared/plugins/images/plugin-image-url'

/** A plugin contribution's image icon (an orca-plugin-image URL main verified), or `fallback`
 *  when it has none or the image fails to load. */
export function PluginContributionIcon({
  url,
  fallback,
  className
}: {
  url: string | undefined
  fallback: LucideIcon
  className: string
}): React.JSX.Element {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  if (!url || failedUrl === url || !parsePluginImageUrl(url)) {
    return createElement(fallback, { className, 'aria-hidden': true })
  }
  // Why alt="": the tab or menu item names what this is; the icon is decoration.
  return (
    <img
      src={url}
      alt=""
      draggable={false}
      decoding="async"
      className={cn('object-contain', className)}
      onError={() => setFailedUrl(url)}
    />
  )
}
