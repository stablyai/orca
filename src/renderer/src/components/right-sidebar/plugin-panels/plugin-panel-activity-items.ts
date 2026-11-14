import { createElement } from 'react'
import { parsePluginImageUrl } from '../../../../../shared/plugins/images/plugin-image-url'
import { Plug } from 'lucide-react'
import type { ActivePluginPanel } from '@/store/plugins/catalog/plugin-contribution-catalog'
import type { ActivityBarItem } from '../activity-bar/activity-bar-buttons'
import { resolvePluginIconGlyph } from '../../plugins/plugin-icon-glyphs'

type PluginPanelIcon = ActivityBarItem['icon']

export function resolvePluginPanelIcon(iconName: string | undefined): PluginPanelIcon {
  const ref = iconName ? parsePluginImageUrl(iconName) : null
  if (ref?.kind === 'installed' && /^panel-\d{1,2}$/.test(ref.slot)) {
    return ({ size = 16, className }) =>
      createElement('span', {
        className,
        style: {
          display: 'inline-block',
          width: size,
          height: size,
          backgroundColor: 'currentColor',
          maskImage: `url("${iconName}")`,
          maskSize: 'contain',
          maskRepeat: 'no-repeat',
          maskPosition: 'center'
        },
        'aria-hidden': true
      })
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
    title: `${panel.pluginName}: ${panel.title}`,
    shortcut: '',
    ...(panelErrors[panel.tabKey] ? { statusIndicator: 'failure' as const } : {})
  }))
}
