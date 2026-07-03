import {
  activateAndRevealFolderWorkspace,
  activateAndRevealWorktree
} from '@/lib/worktree-activation'
import { scheduleAfterInputQuiet } from '@/lib/input-quiet-scheduler'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

export const SIDEBAR_WORKTREE_ACTIVATION_DELAY_MS = 180
export const SIDEBAR_WORKTREE_ACTIVATION_INPUT_QUIET_MS = 120
export const SIDEBAR_WORKTREE_ACTIVATION_IDLE_TIMEOUT_MS = 500

let pendingActivationCancel: (() => void) | null = null
let pendingActivationWorktreeId: string | null = null
let activationGeneration = 0

function clearPendingSidebarActivation(): void {
  pendingActivationCancel?.()
  pendingActivationCancel = null
  pendingActivationWorktreeId = null
}

export function cancelPendingSidebarWorktreeActivation(
  worktreeIds?: readonly string[] | string
): void {
  if (!pendingActivationWorktreeId) {
    return
  }
  const shouldCancel =
    worktreeIds === undefined
      ? true
      : typeof worktreeIds === 'string'
        ? pendingActivationWorktreeId === worktreeIds
        : worktreeIds.includes(pendingActivationWorktreeId)
  if (!shouldCancel) {
    return
  }
  activationGeneration += 1
  clearPendingSidebarActivation()
}

async function runScheduledSidebarActivation(
  worktreeId: string,
  generation: number
): Promise<void> {
  try {
    if (generation !== activationGeneration) {
      return
    }

    if (typeof window !== 'undefined' && window.api?.ephemeralVm?.resumeWorkspace) {
      try {
        await window.api.ephemeralVm.resumeWorkspace({ workspaceId: worktreeId })
      } catch (error) {
        if (generation !== activationGeneration) {
          return
        }
        toast.error(
          translate(
            'auto.lib.sidebarWorktreeActivation.wakeEphemeralVmFailed',
            'Failed to wake ephemeral VM workspace'
          ),
          {
            description: error instanceof Error ? error.message : String(error)
          }
        )
        return
      }
    }

    if (generation !== activationGeneration) {
      return
    }

    // Why: sidebar clicks already happen on a visible row; revealing again can
    // jump duplicate pinned/canonical entries back to the first mounted copy.
    activateAndRevealWorktree(worktreeId, { revealInSidebar: false })
  } finally {
    if (generation === activationGeneration && pendingActivationWorktreeId === worktreeId) {
      pendingActivationWorktreeId = null
    }
  }
}

function scheduleSidebarActivation(worktreeId: string): void {
  const generation = activationGeneration
  pendingActivationWorktreeId = worktreeId
  // Why: active-worktree activation fans out through terminal/editor/sidebar
  // subscribers. Keep the clicked row instant, and skip intermediate worktrees
  // when the user bounces between rows before input has gone quiet.
  pendingActivationCancel = scheduleAfterInputQuiet(
    () => {
      if (generation !== activationGeneration) {
        return
      }
      pendingActivationCancel = null
      void runScheduledSidebarActivation(worktreeId, generation)
    },
    {
      delayMs: SIDEBAR_WORKTREE_ACTIVATION_DELAY_MS,
      quietMs: SIDEBAR_WORKTREE_ACTIVATION_INPUT_QUIET_MS,
      idleTimeoutMs: SIDEBAR_WORKTREE_ACTIVATION_IDLE_TIMEOUT_MS
    }
  )
}

export async function activateWorktreeFromSidebar(worktreeId: string): Promise<void> {
  activationGeneration += 1
  clearPendingSidebarActivation()

  const workspaceScope = parseWorkspaceKey(worktreeId)
  if (workspaceScope?.type === 'folder') {
    activateAndRevealFolderWorkspace(workspaceScope.folderWorkspaceId)
    return
  }

  scheduleSidebarActivation(worktreeId)
}
