import {
  Activity,
  BarChart3,
  Bell,
  Blocks,
  Book,
  Bot,
  Bug,
  Calendar,
  Cloud,
  Code,
  Database,
  FileText,
  Flag,
  Folder,
  Gauge,
  Globe,
  Hammer,
  Layers,
  Lightbulb,
  Package,
  Plug,
  Puzzle,
  Rocket,
  Star,
  Terminal,
  Wrench,
  Zap
} from 'lucide-react'
import type { ActivePluginPanel } from '@/store/plugin-panels'
import type { ActivityBarItem } from './activity-bar-buttons'
import {
  canonicalPluginPanelIcon,
  type PluginPanelIconName
} from '../../../../shared/plugins/contributions/plugin-panel-contribution'

type PluginPanelIcon = ActivityBarItem['icon']

// Why: importing lucide's full `icons` map would bundle every icon and defeat
// tree-shaking, so plugin manifests pick from this closed set (fallback: Plug).
const PLUGIN_PANEL_ICON_COMPONENTS: Record<PluginPanelIconName, PluginPanelIcon> = {
  activity: Activity,
  'bar-chart-3': BarChart3,
  bell: Bell,
  blocks: Blocks,
  book: Book,
  bot: Bot,
  bug: Bug,
  calendar: Calendar,
  cloud: Cloud,
  code: Code,
  database: Database,
  'file-text': FileText,
  flag: Flag,
  folder: Folder,
  gauge: Gauge,
  globe: Globe,
  hammer: Hammer,
  layers: Layers,
  lightbulb: Lightbulb,
  package: Package,
  plug: Plug,
  puzzle: Puzzle,
  rocket: Rocket,
  star: Star,
  terminal: Terminal,
  wrench: Wrench,
  zap: Zap
}

export function resolvePluginPanelIcon(iconName: string | undefined): PluginPanelIcon {
  if (!iconName) {
    return Plug
  }
  // Why canonicalize: hosts from before the closed list still send `FileText`-style names.
  const known = canonicalPluginPanelIcon(iconName)
  return known ? PLUGIN_PANEL_ICON_COMPONENTS[known] : Plug
}

export function getPluginPanelActivityItems(
  panels: ActivePluginPanel[],
  panelErrors: Readonly<Record<string, true>> = {}
): ActivityBarItem[] {
  return panels.map((panel) => ({
    id: panel.tabKey,
    icon: resolvePluginPanelIcon(panel.icon),
    // Manifest titles are plugin-owned and render without app-catalog translation.
    title: panel.title,
    shortcut: '',
    ...(panelErrors[panel.tabKey] ? { statusIndicator: 'failure' as const } : {})
  }))
}
