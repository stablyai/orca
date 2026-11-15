import { useEffect, useState, type ComponentType } from 'react'
import { Plug } from 'lucide-react'
import { pluginPanelIconKind } from '../../../../shared/plugins/contributions/plugin-panel-icon'
import { pluginPanelIconUrl } from '../../../../shared/plugins/images/plugin-image-url'
import { cn } from '@/lib/class-names'
import { resolvePluginIconGlyph } from './plugin-icon-glyphs'

export type PluginPanelIconProps = { size?: number; className?: string }

const panelIconComponents = new Map<string, ComponentType<PluginPanelIconProps>>()

function cachedPanelIcon(
  key: string,
  create: () => ComponentType<PluginPanelIconProps>
): ComponentType<PluginPanelIconProps> {
  const cached = panelIconComponents.get(key)
  if (cached) {
    return cached
  }
  const component = create()
  panelIconComponents.set(key, component)
  return component
}

function SvgPanelIcon({
  url,
  size = 18,
  className
}: PluginPanelIconProps & { url: string }): React.JSX.Element {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    setReady(false)
    let current = true
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.onload = () => {
      if (current) {
        setReady(true)
      }
    }
    image.src = url
    return () => {
      current = false
      image.onload = null
    }
  }, [url])
  if (!ready) {
    return <Plug size={size} className={className} />
  }
  const image = `url("${url}")`
  return (
    <span
      className={cn('inline-block shrink-0 bg-current', className)}
      style={{
        width: size,
        height: size,
        maskImage: image,
        maskPosition: 'center',
        maskRepeat: 'no-repeat',
        maskSize: 'contain',
        WebkitMaskImage: image,
        WebkitMaskPosition: 'center',
        WebkitMaskRepeat: 'no-repeat',
        WebkitMaskSize: 'contain'
      }}
      aria-hidden="true"
    />
  )
}

/** The icon component for a panel's manifest value and its optional main-served file URL. */
export function resolvePluginPanelIcon(
  icon: string | undefined,
  iconUrl?: string
): ComponentType<PluginPanelIconProps> {
  const kind = icon ? pluginPanelIconKind(icon) : null
  if (kind === 'file' && icon) {
    const url = iconUrl ? pluginPanelIconUrl(iconUrl) : null
    if (url) {
      return cachedPanelIcon(`svg:${url}`, () => (props) => <SvgPanelIcon {...props} url={url} />)
    }
  }
  return resolvePluginIconGlyph(icon, Plug)
}
