import {
  RUNTIME_ENVIRONMENT_ASLEEP_MESSAGE,
  RUNTIME_ENVIRONMENT_WAKE_FAILED_MESSAGE,
  RUNTIME_ENVIRONMENT_WAKING_MESSAGE
} from '../../../../shared/remote-runtime/recipe-vm-wake'
import { useCloudWorkspaceView } from './use-cloud-workspace-view'

// Older builds' wording too: a terminal error saved before this change still reads "VM".
const SLEEP_PATTERNS = [
  RUNTIME_ENVIRONMENT_ASLEEP_MESSAGE,
  RUNTIME_ENVIRONMENT_WAKING_MESSAGE,
  RUNTIME_ENVIRONMENT_WAKE_FAILED_MESSAGE,
  "This workspace's VM is asleep",
  "This workspace's VM could not wake up"
]

function isSleepTerminalError(error: string): boolean {
  return SLEEP_PATTERNS.some((pattern) => error.includes(pattern))
}

/**
 * The terminal's error toast for an Orca Cloud workspace that is asleep or waking: never shown.
 * Waking, the waking pill owns the state; asleep, the pane's recovery slot shows one calm line with
 * Wake (CloudAsleepTerminalNotice, RA-12), so a red "file an issue" toast would only repeat it.
 * Other errors, and other hosts, keep the regular toast.
 */
export function useCloudTerminalErrorOverride(
  worktreeId: string,
  error: string | null | undefined
): 'hide' | null {
  const view = useCloudWorkspaceView(worktreeId)
  return view.isCloud && error && isSleepTerminalError(error) ? 'hide' : null
}
