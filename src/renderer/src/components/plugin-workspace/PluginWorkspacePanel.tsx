import { X } from 'lucide-react'
import PluginPanel from '../right-sidebar/PluginPanel'
import { usePluginPanels, usePluginPanelsStore } from '@/store/plugin-panels'
import { Button } from '@/components/ui/button'

export function PluginWorkspacePanel(): React.JSX.Element | null {
  const tabKey = usePluginPanelsStore((state) => state.activeWorkspacePanel)
  const close = usePluginPanelsStore((state) => state.closeWorkspacePanel)
  const panels = usePluginPanels()
  const panel = panels.find(
    (candidate) => candidate.tabKey === tabKey && candidate.location === 'workspace'
  )

  if (!tabKey || !panel) {
    return null
  }

  return (
    <section className="absolute inset-0 z-20 flex min-h-0 flex-col bg-background">
      <header className="titlebar flex shrink-0 items-center border-b border-border px-3">
        <div className="min-w-0 flex-1 truncate text-sm font-medium">{panel.title}</div>
        <Button variant="ghost" size="icon" onClick={close} aria-label="Close workspace view">
          <X className="size-4" />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1">
        {/* Why key: same rule as the sidebar — switching views must remount the
            sandboxed iframe so a reused frame cannot keep posting messages while
            the bridge rebinds under the next panel's session. */}
        <PluginPanel key={tabKey} tabKey={tabKey} expectedLocation="workspace" />
      </div>
    </section>
  )
}
