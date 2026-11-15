import { useEffect, useState, type ComponentType } from 'react'
import { Plug } from 'lucide-react'
import {
  pluginPanelIconFileFormat,
  pluginPanelIconKind
} from '../../../../shared/plugins/contributions/plugin-panel-icon'
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

function EmojiPanelIcon({
  icon,
  size = 18,
  className
}: PluginPanelIconProps & { icon: string }): React.JSX.Element {
  return (
    <span
      className={cn('inline-flex shrink-0 items-center justify-center leading-none', className)}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.9) }}
      aria-hidden="true"
    >
      {icon}
    </span>
  )
}

function PngPanelIcon({
  url,
  size = 18,
  className
}: PluginPanelIconProps & { url: string }): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [url])
  return failed ? (
    <Plug size={size} className={className} />
  ) : (
    <img
      src={url}
      alt=""
      aria-hidden="true"
      draggable={false}
      width={size}
      height={size}
      className={cn('shrink-0 object-contain', className)}
      onError={() => setFailed(true)}
    />
  )
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
  if (kind === 'emoji' && icon) {
    return cachedPanelIcon(`emoji:${icon}`, () => (props) => (
      <EmojiPanelIcon {...props} icon={icon} />
    ))
  }
  if (kind === 'file' && icon) {
    const url = iconUrl ? pluginPanelIconUrl(iconUrl) : null
    const format = pluginPanelIconFileFormat(icon)
    if (url && format === 'svg') {
      return cachedPanelIcon(`svg:${url}`, () => (props) => <SvgPanelIcon {...props} url={url} />)
    }
    if (url && format === 'png') {
      return cachedPanelIcon(`png:${url}`, () => (props) => <PngPanelIcon {...props} url={url} />)
    }
  }
  return resolvePluginIconGlyph(icon, Plug)
}
