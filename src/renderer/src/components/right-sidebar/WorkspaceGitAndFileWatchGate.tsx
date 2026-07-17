import { useEditorExternalWatch } from '@/hooks/useEditorExternalWatch'
import { useGitStatusPolling } from './useGitStatusPolling'

// Why: sidebar visibility drives both hooks; isolating their subscriptions in
// a leaf keeps transient edge peeks from re-rendering the entire App tree.
export function WorkspaceGitAndFileWatchGate({ enabled }: { enabled: boolean }): null {
  // Why: conflict badges need Git status even with the sidebar closed; defer
  // the first scan until session hydration keeps it off the startup path.
  useGitStatusPolling({ enabled })
  // Why: open editors must hear file changes regardless of which sidebar tab
  // is mounted, so watcher ownership stays at the workspace level.
  useEditorExternalWatch()
  return null
}
