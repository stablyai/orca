import { createElement, isValidElement, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { parsePluginImageUrl } from '../../../../shared/plugins/images/plugin-image-url'

/** A plugin contribution's image icon (an orca-plugin-image URL main verified), or `fallback`
 *  (an icon component or a rendered element) when it has none or the image fails to load. */
export function PluginContributionIcon({
  url,
  fallback,
  className,
  size
}: {
  url: string | undefined
  fallback: LucideIcon | React.ReactElement
  className: string
  /** Box side in CSS pixels, for callers that size icons by a number like Lucide's `size`. */
  size?: number
}): React.JSX.Element {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  if (!url || failedUrl === url || !parsePluginImageUrl(url)) {
    return isValidElement(fallback)
      ? fallback
      : createElement(fallback, { className, 'aria-hidden': true })
  }
  // Why alt="": the tab or menu item names what this is; the icon is decoration.
  return (
    <img
      src={url}
      alt=""
      draggable={false}
      decoding="async"
      className={cn('object-contain', className)}
      // Why a style too: preflight's `height: auto` would override the height attribute.
      {...(size === undefined
        ? {}
        : { width: size, height: size, style: { width: size, height: size } })}
      onError={() => setFailedUrl(url)}
    />
  )
}
