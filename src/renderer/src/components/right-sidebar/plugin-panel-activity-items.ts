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

type PluginPanelIcon = ActivityBarItem['icon']

// Why: importing lucide's full `icons` map would bundle every icon and defeat
// tree-shaking, so plugin manifests pick from this curated set (fallback: Plug).
const PLUGIN_PANEL_ICONS: Record<string, PluginPanelIcon> = {
  activity: Activity,
  barchart3: BarChart3,
  bell: Bell,
  blocks: Blocks,
  book: Book,
  bot: Bot,
  bug: Bug,
  calendar: Calendar,
  cloud: Cloud,
  code: Code,
  database: Database,
  filetext: FileText,
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
  // Accept both lucide naming styles ('file-text' and 'FileText').
  const normalized = iconName.replaceAll('-', '').toLowerCase()
  return PLUGIN_PANEL_ICONS[normalized] ?? Plug
}

/** Maps active plugin panel contributions onto right-sidebar activity items. */
export function getPluginPanelActivityItems(
  panels: ActivePluginPanel[],
  panelErrors: Readonly<Record<string, true>> = {}
): ActivityBarItem[] {
  return panels.map((panel) => ({
    id: panel.tabKey,
    icon: resolvePluginPanelIcon(panel.icon),
    // Why: panel titles come from plugin manifests, not the app catalog, so
    // they render untranslated by design.
    title: panel.title,
    shortcut: '',
    ...(panelErrors[panel.tabKey] ? { statusIndicator: 'failure' as const } : {})
  }))
}
