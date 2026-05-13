import type { GlobalSettings } from '../../../../shared/types'
import {
  quickCreateDefaultWorkspace,
  type QuickCreateDefaultWorkspaceArgs
} from '@/lib/quick-create-default-workspace'

type SidebarWorkspaceCreateActionArgs = {
  canCreateWorkspace: boolean
  settings: GlobalSettings | null | undefined
  quickCreateInFlight: { current: boolean }
  setQuickCreating: (creating: boolean) => void
  openComposer: () => void
  quickCreate?: (args: QuickCreateDefaultWorkspaceArgs) => Promise<void>
}

export function startSidebarWorkspaceCreateAction({
  canCreateWorkspace,
  settings,
  quickCreateInFlight,
  setQuickCreating,
  openComposer,
  quickCreate = quickCreateDefaultWorkspace
}: SidebarWorkspaceCreateActionArgs): void {
  if (!canCreateWorkspace || quickCreateInFlight.current) {
    return
  }

  const hasConfiguredDefaultAgent =
    settings?.defaultTuiAgent !== null && settings?.defaultTuiAgent !== undefined
  if (settings?.quickCreateWorkspaceWithDefaultAgent && hasConfiguredDefaultAgent) {
    // Why: React state may not disable the button before a second click event;
    // this ref closes that duplicate-create window synchronously.
    quickCreateInFlight.current = true
    setQuickCreating(true)
    void quickCreate({ openModalFallback: openComposer }).finally(() => {
      quickCreateInFlight.current = false
      setQuickCreating(false)
    })
    return
  }

  openComposer()
}
