import React from 'react'
import { Network } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

// Why: shown on branch/PR-centric right-sidebar panels (e.g. Checks) when the
// active worktree is an Orcastrator director. A director has no branch or PR of
// its own, so those panels' normal content is misleading — explain that and send
// the user to the director's console (Mission Control, in the Source Control tab).
export default function OrchestratorPanelNotice(): React.JSX.Element {
  const setRightSidebarTab = useAppStore((s) => s.setRightSidebarTab)
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <Network className="size-6 text-muted-foreground" aria-hidden />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">
          {translate('auto.components.right.sidebar.OrchestratorPanelNotice.title', 'Orcastrator')}
        </p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {translate(
            'auto.components.right.sidebar.OrchestratorPanelNotice.body',
            'A director has no branch or pull request of its own, so there are no checks here. Each worker opens its own pull request, where its checks run.'
          )}
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={() => setRightSidebarTab('source-control')}>
        {translate(
          'auto.components.right.sidebar.OrchestratorPanelNotice.open_mission_control',
          'Open Mission Control'
        )}
      </Button>
    </div>
  )
}
