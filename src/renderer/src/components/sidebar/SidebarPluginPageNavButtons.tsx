import React, { useMemo } from 'react'
import { Plug } from 'lucide-react'
import { useAppStore } from '@/store/index'
import { usePluginPanels } from '@/store/plugins/catalog/plugin-contribution-catalog'
import { resolvePluginIconGlyph } from '../plugins/plugin-icon-glyphs'
import { SidebarNavPageButton } from './sidebar-nav-page-button'

/** Entries for enabled plugins' `placement: "page"` panels, below the built-in pages. */
export function SidebarPluginPageNavButtons(): React.JSX.Element | null {
  const pluginSystemEnabled = useAppStore((s) => s.settings?.pluginSystemEnabled === true)
  const activeTabKey = useAppStore((s) =>
    s.activeView === 'plugin-page' ? s.activePluginPageTabKey : null
  )
  const openPluginPage = useAppStore((s) => s.openPluginPage)
  const panels = usePluginPanels()
  const pagePanels = useMemo(
    () => (pluginSystemEnabled ? panels.filter((panel) => panel.placement === 'page') : []),
    [panels, pluginSystemEnabled]
  )
  if (pagePanels.length === 0) {
    return null
  }
  return (
    <>
      {pagePanels.map((panel) => (
        <SidebarNavPageButton
          key={panel.tabKey}
          // Manifest titles are plugin-owned and render without app-catalog translation.
          label={panel.title}
          icon={resolvePluginIconGlyph(panel.icon, Plug)}
          active={activeTabKey === panel.tabKey}
          onClick={() => openPluginPage(panel.tabKey)}
        />
      ))}
    </>
  )
}
