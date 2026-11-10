import { useEffect } from 'react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'
import {
  useSecretRequests,
  type SecretRequestEntry
} from '@/lib/secret-requests/secret-request-store'
import {
  secretRequestAgentName,
  unseenSecretRequests
} from '@/lib/secret-requests/secret-request-routing'
import { secretRequestTitle } from './SecretRequestCard'
import { useSecretRequestSlots } from './secret-request-focus'

// Panes mount a moment after their stream attaches; don't toast for a card that's about to show.
const SETTLE_MS = 2_000
const told = new Set<string>()

/** The workspace on this computer that the asking host's request belongs to. */
function workspaceFor(entry: SecretRequestEntry): { id: string; name: string } | null {
  const all = Object.values(selectWorktreesByRepo(useAppStore.getState()) ?? {}).flat()
  const match =
    all.find((worktree) => worktree.id === entry.event.worktreeId) ??
    all.find((worktree) => worktree.runtimeOwnerEnvironmentId === entry.environmentId)
  return match ? { id: match.id, name: match.displayName } : null
}

/**
 * A request whose workspace isn't on screen would otherwise wait unseen until it expires: say so
 * once, name the workspace, and open it on click.
 */
export function SecretRequestUnseenNotifier(): null {
  const t = useTranslate()
  const requests = useSecretRequests()
  const slots = useSecretRequestSlots()
  useEffect(() => {
    const unseen = unseenSecretRequests(requests, slots).filter(
      (entry) => !told.has(`${entry.environmentId}:${entry.event.requestId}`)
    )
    if (unseen.length === 0) {
      return
    }
    const timer = window.setTimeout(() => {
      for (const entry of unseen) {
        told.add(`${entry.environmentId}:${entry.event.requestId}`)
        const workspace = workspaceFor(entry)
        toast.info(
          secretRequestTitle(secretRequestAgentName(entry.event.agent), entry.event.name, t),
          {
            description: workspace
              ? t(
                  'secretRequest.unseenIn',
                  'In {{workspace}}. The request waits up to 15 minutes.',
                  {
                    workspace: workspace.name
                  }
                )
              : t(
                  'secretRequest.unseen',
                  'Open that workspace to answer. The request waits up to 15 minutes.'
                ),
            action: workspace
              ? {
                  label: t('secretRequest.openWorkspace', 'Open'),
                  onClick: () => activateAndRevealWorktree(workspace.id)
                }
              : undefined
          }
        )
      }
    }, SETTLE_MS)
    return () => window.clearTimeout(timer)
  }, [requests, slots, t])
  return null
}
