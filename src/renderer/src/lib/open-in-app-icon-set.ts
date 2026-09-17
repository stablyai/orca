import {
  AppWindow,
  Bot,
  Box,
  Braces,
  Code2,
  Database,
  FileCode,
  FolderOpen,
  Globe,
  Palette,
  PanelsTopLeft,
  Pencil,
  Rocket,
  Sparkles,
  SquareTerminal,
  Wrench,
  type LucideIcon
} from 'lucide-react'
import { OPEN_IN_APP_ICON_IDS, type OpenInAppIconId } from '../../../shared/open-in-app-icons'
import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

const OPEN_IN_APP_ICON_GLYPHS: Record<OpenInAppIconId, LucideIcon> = {
  AppWindow,
  Code2,
  SquareTerminal,
  FileCode,
  Braces,
  Pencil,
  PanelsTopLeft,
  Bot,
  Sparkles,
  Database,
  Globe,
  FolderOpen,
  Rocket,
  Wrench,
  Palette,
  Box
}

export type OpenInAppIconOption = {
  id: OpenInAppIconId
  label: string
  icon: LucideIcon
}

export function getOpenInAppIconGlyph(id: OpenInAppIconId): LucideIcon {
  return OPEN_IN_APP_ICON_GLYPHS[id]
}

export const getOpenInAppIconOptions = createLocalizedCatalog((): OpenInAppIconOption[] => {
  const labels: Record<OpenInAppIconId, string> = {
    AppWindow: translate('auto.lib.open.in.app.icon.set.appWindow', 'App'),
    Code2: translate('auto.lib.open.in.app.icon.set.code', 'Code'),
    SquareTerminal: translate('auto.lib.open.in.app.icon.set.terminal', 'Terminal'),
    FileCode: translate('auto.lib.open.in.app.icon.set.editor', 'Editor'),
    Braces: translate('auto.lib.open.in.app.icon.set.braces', 'Braces'),
    Pencil: translate('auto.lib.open.in.app.icon.set.notes', 'Notes'),
    PanelsTopLeft: translate('auto.lib.open.in.app.icon.set.panels', 'Panels'),
    Bot: translate('auto.lib.open.in.app.icon.set.agent', 'Agent'),
    Sparkles: translate('auto.lib.open.in.app.icon.set.ai', 'AI'),
    Database: translate('auto.lib.open.in.app.icon.set.database', 'Database'),
    Globe: translate('auto.lib.open.in.app.icon.set.browser', 'Browser'),
    FolderOpen: translate('auto.lib.open.in.app.icon.set.files', 'Files'),
    Rocket: translate('auto.lib.open.in.app.icon.set.launch', 'Launch'),
    Wrench: translate('auto.lib.open.in.app.icon.set.tools', 'Tools'),
    Palette: translate('auto.lib.open.in.app.icon.set.design', 'Design'),
    Box: translate('auto.lib.open.in.app.icon.set.box', 'Box')
  }
  return OPEN_IN_APP_ICON_IDS.map((id) => ({
    id,
    label: labels[id],
    icon: OPEN_IN_APP_ICON_GLYPHS[id]
  }))
})
