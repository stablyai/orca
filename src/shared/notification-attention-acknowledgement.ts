import {
  attentionOriginWasRead,
  type StructuredAttentionOrigin
} from './agent-session/agent-session-attention'
import { agentSessionScopeKey } from './agent-session/lifecycle/agent-session-record'
import type {
  NotificationAttentionAcknowledgement,
  NotificationDispatchRequest
} from './notification-settings-types'
import { toHostSessionPaneKey } from './terminal-surface-id'

type Announcement = Pick<
  NotificationDispatchRequest,
  'worktreeId' | 'executionHost' | 'workspaceExecutionHostId' | 'paneKey'
> & { origin?: StructuredAttentionOrigin }

/** Transport ownership is separate from the producer's local/SSH/WSL location. */
export function notificationWasAcknowledged(
  entry: Announcement,
  acknowledgement: NotificationAttentionAcknowledgement,
  executionHost?: NotificationDispatchRequest['executionHost']
): boolean {
  if (entry.executionHost !== executionHost) {
    return false
  }
  if (entry.origin) {
    return acknowledgement.reads.some(
      (read) =>
        (read.scope !== undefined ||
          (typeof read.paneKey === 'string' &&
            typeof entry.paneKey === 'string' &&
            toHostSessionPaneKey(read.paneKey) === toHostSessionPaneKey(entry.paneKey))) &&
        attentionOriginWasRead(entry.origin, read)
    )
  }
  if (entry.workspaceExecutionHostId === null) {
    return false
  }
  const workspace = acknowledgement.worktree
  const workspaceExecutionHostId =
    entry.workspaceExecutionHostId === executionHost
      ? 'local'
      : (entry.workspaceExecutionHostId ?? 'local')
  const acknowledgedExecutionHostId =
    workspace?.executionHostId === executionHost ? 'local' : workspace?.executionHostId
  return (
    workspace !== undefined &&
    entry.worktreeId === workspace.workspaceId &&
    workspaceExecutionHostId === acknowledgedExecutionHostId
  )
}

/** Keep bounded read positions so a delayed completion cannot resurrect acknowledged attention. */
export class NotificationAttentionReadFrontiers {
  private readonly reads = new Map<
    string,
    {
      read: NotificationAttentionAcknowledgement['reads'][number]
      executionHost?: NotificationDispatchRequest['executionHost']
    }
  >()

  accept(
    acknowledgement: NotificationAttentionAcknowledgement,
    executionHost?: NotificationDispatchRequest['executionHost']
  ): void {
    for (const read of acknowledgement.reads) {
      const key = JSON.stringify([
        executionHost,
        read.scope ? agentSessionScopeKey(read.scope) : null,
        read.paneKey,
        read.sessionId,
        read.observedCursor.epoch
      ])
      const previous = this.reads.get(key)
      if (previous && previous.read.observedCursor.sequence >= read.observedCursor.sequence) {
        continue
      }
      this.reads.delete(key)
      this.reads.set(key, { read, executionHost })
      if (this.reads.size > 256) {
        const oldest = this.reads.keys().next().value
        if (oldest !== undefined) {
          this.reads.delete(oldest)
        }
      }
    }
  }

  covers(entry: Announcement): boolean {
    return [...this.reads.values()].some(({ read, executionHost }) =>
      notificationWasAcknowledged(entry, { reads: [read] }, executionHost)
    )
  }
}
