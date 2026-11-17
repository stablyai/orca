import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { selectKnownWorktreeById } from '@/store/workspaces/selection/known-worktree-selection'
import { repoMatchesHostIdentity } from '@/store/repos/repo-host-identity'
import {
  selectDetectedWorktreesByRepo,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'
import { executionHostIdForStructuredTarget } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import { activateWorktreeFromSidebar } from '@/lib/workspace/activation/sidebar-worktree-activation'
import { importNewExternalWorktreeInboxPaths } from '@/components/sidebar/worktree-list/listing/new-external-worktrees-inbox-actions'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host/execution-host'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { useStructuredAgentSessionWorkingDirectory } from '../../session/status/structured-agent-session-status-hooks'
import {
  resolveNativeChatWorkingLocation,
  type NativeChatWorkingLocation
} from './native-chat-working-location'
import { NativeChatWorkingLocationLabel } from './NativeChatWorkingLocationLabel'

type WorktreeLocation = Extract<NativeChatWorkingLocation, { kind: 'worktree' }>

/** Import a hidden discovered worktree the way the visibility dialog does; false when that fails. */
async function revealHiddenWorktree(location: WorktreeLocation): Promise<boolean> {
  const state = useAppStore.getState()
  // The worktree's own host picks the repo; the active workspace may be on another host.
  const hostId = location.hostId ?? LOCAL_EXECUTION_HOST_ID
  const repo = state.repos.find((row) => repoMatchesHostIdentity(row, location.repoId, hostId))
  if (!repo) {
    return false
  }
  let failed = false
  await importNewExternalWorktreeInboxPaths({
    projectId: repo.id,
    repo,
    worktreePaths: [location.path],
    updateRepo: (projectId, updates) => state.updateRepo(projectId, updates, { hostId }),
    fetchWorktrees: (projectId, options) =>
      state.fetchWorktrees(projectId, { ...options, executionHostId: hostId }),
    setInboxState: (_projectId, inbox) => {
      failed ||= Boolean(inbox?.error)
    }
  })
  return !failed
}

/** Switch the view to the worktree, revealing it first when hidden; false when it cannot be shown. */
async function openWorktreeLocation(location: WorktreeLocation): Promise<boolean> {
  if (location.hidden && !(await revealHiddenWorktree(location))) {
    return false
  }
  await activateWorktreeFromSidebar(location.worktreeId, location.hostId)
  return true
}

/** Says where the chat's agent works when it left the chat's workspace, and opens that worktree. */
export function NativeChatWorkingLocationChip({
  sessionId,
  worktreeId,
  target
}: {
  sessionId: string
  worktreeId: string
  target: RuntimeClientTarget
}): React.JSX.Element | null {
  const t = useTranslate()
  const workingDirectory = useStructuredAgentSessionWorkingDirectory(sessionId, target)
  const chatHostId = executionHostIdForStructuredTarget(target)
  const chatWorktree = useAppStore((state) =>
    selectKnownWorktreeById(state, worktreeId, chatHostId)
  )
  const worktrees = useAppStore(selectWorktreesByRepo)
  const detectedWorktrees = useAppStore(selectDetectedWorktreesByRepo)
  const [opening, setOpening] = useState(false)
  const location = useMemo(
    () =>
      resolveNativeChatWorkingLocation({
        workingDirectory,
        chatHostId,
        chatWorktree: chatWorktree ?? undefined,
        worktrees,
        detectedWorktrees
      }),
    [chatHostId, chatWorktree, detectedWorktrees, workingDirectory, worktrees]
  )
  if (!location) {
    return null
  }
  const revealFailed = t(
    'components.native-chat.workingLocation.revealFailed',
    'Could not show that worktree.'
  )
  const open = (): void => {
    if (location.kind !== 'worktree' || opening) {
      return
    }
    setOpening(true)
    void openWorktreeLocation(location)
      .catch(() => false)
      .then((shown) => {
        if (!shown) {
          toast.error(revealFailed)
        }
        setOpening(false)
      })
  }
  return <NativeChatWorkingLocationLabel location={location} opening={opening} onOpen={open} />
}
