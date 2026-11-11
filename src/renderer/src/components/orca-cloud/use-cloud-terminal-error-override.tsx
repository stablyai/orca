import React from 'react'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { findWorktreeById } from '@/store/github/refresh/worktree-refresh'
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
 * The terminal's error toast for an Orca Cloud workspace that is asleep or waking (RA-10 follow-up).
 * While it wakes, the waking pill owns the state, so no toast at all. Asleep, a neutral line
 * instead of a red error with "file an issue". Other errors, and other hosts, are left alone.
 */
export function useCloudTerminalErrorOverride(
  worktreeId: string,
  error: string | null | undefined
): 'hide' | React.JSX.Element | null {
  const t = useTranslate()
  const view = useCloudWorkspaceView(worktreeId)
  const name = useAppStore((state) => findWorktreeById(state, worktreeId)?.displayName ?? null)
  if (!view.isCloud || !error || !isSleepTerminalError(error)) {
    return null
  }
  if (view.state === 'waking' || view.state === 'starting' || view.state === 'running') {
    return 'hide'
  }
  return (
    <div
      data-cloud-asleep-terminal-notice=""
      role="status"
      className="absolute inset-x-3 bottom-3 z-50 rounded-md border border-border bg-popover px-3.5 py-2.5 text-xs text-muted-foreground"
    >
      {name
        ? t('orcaCloudWorkspace.terminal.asleepNamed', '{{name}} is asleep. Open it to wake it.', {
            name
          })
        : t('orcaCloudWorkspace.terminal.asleep', 'This workspace is asleep. Open it to wake it.')}
    </div>
  )
}
