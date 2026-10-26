import type { JiraIssue, JiraMutationResult } from '../../../shared/jira/jira-types'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { getJiraReadIdentity } from '@/store/slices/jira-read-coordination'
import {
  editedJiraIssueFields,
  jiraIssueRollbackPatch,
  mergeJiraIssueHydration
} from './jira-issue-workspace-hydration'

type IssuePatchListener = (
  patch: Partial<JiraIssue>,
  rollback: boolean,
  statusSettled: boolean,
  commentsChanged: boolean
) => void
type IssueWrite = {
  confirmed: JiraIssue
  pending: { patch: Partial<JiraIssue> }[]
  tail: Promise<void> | null
}

const writes = new Map<string, IssueWrite>()
const listeners = new Map<string, Set<IssuePatchListener>>()

export function jiraIssueRequestScope(
  issue: JiraIssue | null,
  sourceContext: TaskSourceContext | null | undefined,
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
): string | null {
  if (!issue) {
    return null
  }
  const scope = getJiraReadIdentity(settings, sourceContext)
  return JSON.stringify([
    scope.cachePrefix ?? scope.contextKey,
    issue.siteId ?? 'selected',
    issue.key
  ])
}

export function subscribeJiraIssueMutation(
  scope: string,
  listener: IssuePatchListener,
  replay: (patch: Partial<JiraIssue>) => void
): () => void {
  const subscribers = listeners.get(scope) ?? new Set<IssuePatchListener>()
  subscribers.add(listener)
  listeners.set(scope, subscribers)
  const pendingPatch: Partial<JiraIssue> = {}
  for (const mutation of writes.get(scope)?.pending ?? []) {
    Object.assign(pendingPatch, mutation.patch)
  }
  if (Object.keys(pendingPatch).length > 0) {
    replay(pendingPatch)
  }
  return () => {
    subscribers.delete(listener)
    if (subscribers.size === 0) {
      listeners.delete(scope)
    }
  }
}

export function enqueueJiraIssueMutation({
  scope,
  previous,
  optimistic,
  commentsChanged = false,
  update,
  refresh,
  patchIssue
}: {
  scope: string
  previous: JiraIssue
  optimistic: Partial<JiraIssue>
  commentsChanged?: boolean
  update: () => Promise<JiraMutationResult>
  refresh: () => Promise<JiraIssue | null>
  patchIssue: (patch: Partial<JiraIssue>) => void
}): Promise<void> {
  const write: IssueWrite = writes.get(scope) ?? { confirmed: previous, pending: [], tail: null }
  const predecessor = write.tail
  const protectedFields = new Set(
    write.pending.flatMap((queued) => editedJiraIssueFields(queued.patch))
  )
  write.confirmed = mergeJiraIssueHydration(previous, write.confirmed, protectedFields)
  const mutation = { patch: optimistic }
  write.pending.push(mutation)
  writes.set(scope, write)

  const publish = (
    patch: Partial<JiraIssue>,
    rollback: boolean,
    statusSettled = false,
    changedComments = false
  ): void => {
    if (Object.keys(patch).length === 0) {
      return
    }
    patchIssue(patch)
    for (const listener of listeners.get(scope) ?? []) {
      listener(patch, rollback, statusSettled, changedComments)
    }
  }
  publish(optimistic, false)

  // Serialize this issue across reopen/remount, preserving later optimistic fields.
  const request = (async (): Promise<void> => {
    await predecessor?.catch(() => undefined)
    let saved = false
    let refreshed = false
    try {
      const result = await update()
      if (!result.ok) {
        throw new Error(result.error)
      }
      saved = true
      write.confirmed = { ...write.confirmed, ...optimistic }
      try {
        const latest = await refresh()
        if (latest) {
          const newerFields = new Set(
            write.pending
              .filter((queued) => queued !== mutation)
              .flatMap((queued) => editedJiraIssueFields(queued.patch))
              .filter((field) => !(field in optimistic))
          )
          write.confirmed = mergeJiraIssueHydration(latest, write.confirmed, newerFields)
          refreshed = true
        }
      } catch {
        // A failed refresh does not undo a successful save.
      }
    } finally {
      write.pending.splice(write.pending.indexOf(mutation), 1)
      let patch: Partial<JiraIssue> = saved
        ? refreshed
          ? write.confirmed
          : optimistic
        : jiraIssueRollbackPatch(write.confirmed, optimistic)
      for (const newer of write.pending) {
        if (saved) {
          patch = { ...patch, ...newer.patch }
        } else {
          for (const field of editedJiraIssueFields(newer.patch)) {
            delete patch[field]
          }
        }
      }
      publish(
        patch,
        !saved,
        'status' in optimistic && !write.pending.some((queued) => 'status' in queued.patch),
        saved && commentsChanged
      )
    }
  })()
  write.tail = request
  const cleanup = (): void => {
    if (writes.get(scope)?.tail === request) {
      writes.delete(scope)
    }
  }
  void request.then(cleanup, cleanup)
  return request
}
