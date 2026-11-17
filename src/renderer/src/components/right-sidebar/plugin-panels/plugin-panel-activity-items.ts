import { createElement, useState } from 'react'
import { parsePluginImageUrl } from '../../../../../shared/plugins/images/plugin-image-url'
import { Plug } from 'lucide-react'
import type { ActivePluginPanel } from '@/store/plugins/catalog/plugin-contribution-catalog'
import type { ActivityBarItem } from '../activity-bar/activity-bar-buttons'
import { resolvePluginIconGlyph } from '../../plugins/plugin-icon-glyphs'

type PluginPanelIcon = ActivityBarItem['icon']

const panelIconComponents = new Map<string, PluginPanelIcon>()

export function resolvePluginPanelIcon(iconName: string | undefined): PluginPanelIcon {
  const ref = iconName ? parsePluginImageUrl(iconName) : null
  if (iconName && ref?.kind === 'installed' && /^panel-\d{1,2}$/.test(ref.slot)) {
    const cached = panelIconComponents.get(iconName)
    if (cached) {
      return cached
    }
    const url = iconName
    const Icon: PluginPanelIcon = ({ size = 16, className }) => {
      const [failed, setFailed] = useState(false)
      if (failed) {
        return createElement(Plug, { size, className })
      }
      return createElement(
        'span',
        {
          className,
          style: {
            display: 'inline-block',
            width: size,
            height: size,
            backgroundColor: 'currentColor',
            maskImage: `url("${url}")`,
            maskSize: 'contain',
            maskRepeat: 'no-repeat',
            maskPosition: 'center',
            forcedColorAdjust: 'none'
          },
          'aria-hidden': true
        },
        createElement('img', {
          src: url,
          onError: () => setFailed(true),
          alt: '',
          style: { display: 'none' }
        })
      )
    }
    panelIconComponents.set(url, Icon)
    return Icon
  }
  return resolvePluginIconGlyph(iconName, Plug)
}

export function getPluginPanelActivityItems(
  panels: ActivePluginPanel[],
  panelErrors: Readonly<Record<string, true>> = {}
): ActivityBarItem[] {
  return panels.map((panel) => ({
    id: panel.tabKey,
    pluginKey: panel.pluginKey,
    icon: resolvePluginPanelIcon(panel.icon),
    // Manifest titles are plugin-owned and render without app-catalog translation.
    title: panel.title,
    accessibleTitle: panel.title.toLowerCase().startsWith(panel.pluginName.toLowerCase())
      ? panel.title
      : `${panel.pluginName}: ${panel.title}`,
    shortcut: '',
    ...(panelErrors[panel.tabKey] ? { statusIndicator: 'failure' as const } : {})
  }))
}
