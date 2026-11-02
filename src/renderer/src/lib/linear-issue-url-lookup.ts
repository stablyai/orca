import { linearStatus } from '@/runtime/runtime-linear-client'
import {
  credentialDecryptionMessage,
  isIntegrationCredentialDecryptionError
} from '../../../shared/integration-credential-errors'
import {
  findLinearIssueWorkspaceLookupIds,
  isLinearIssueUrlResolutionMatch,
  type LinearIssueUrlIntent
} from '../../../shared/linear/links'
import type { LinearIssue } from '../../../shared/linear/issue-types'
import type { LinearConnectionStatus } from '../../../shared/linear/workspace-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import type {
  LinearIssueRead,
  LinearIssueLease,
  LinearIssueView
} from '@/store/slices/linear/linear-issue-publication'

type Status = Pick<
  LinearConnectionStatus,
  'workspaces' | 'viewer' | 'activeWorkspaceId' | 'selectedWorkspaceId'
>
type FetchLinearIssue = (
  identifier: string,
  workspaceId?: string | null,
  options?: { sourceContext?: TaskSourceContext | null }
) => LinearIssueRead<LinearIssue | null>

export function lookupLinearIssueUrl({
  intent,
  knownStatus,
  sourceContext,
  fetchLinearIssue,
  readLinearStatus = (context) => linearStatus(context ?? { kind: 'local' })
}: {
  intent: LinearIssueUrlIntent
  knownStatus: Status
  sourceContext: TaskSourceContext | null
  fetchLinearIssue: FetchLinearIssue
  readLinearStatus?: (source: TaskSourceContext | null) => Promise<LinearConnectionStatus>
}): LinearIssueRead<LinearIssue | null> {
  return {
    acquire: (isLive = () => true) => {
      let live = true
      let view: LinearIssueView<LinearIssue | null> = { kind: 'loading', data: null }
      let child: LinearIssueLease<LinearIssue | null> | null = null
      let childView: LinearIssueView<LinearIssue | null> | null = null
      let unsubscribe = () => {}
      const listeners = new Set<() => void>()
      const notify = () => {
        // oxlint-disable-next-line unicorn/no-useless-spread -- Why: subscribers may change the listener set synchronously.
        for (const listener of [...listeners]) {
          listener()
        }
      }
      const current = () => live && isLive()
      const tried = new Set<string>()
      let credentialFailure = false
      const lookup = async (status: Status): Promise<boolean> => {
        for (const workspaceId of findLinearIssueWorkspaceLookupIds(intent, status)) {
          if (!current()) {
            return true
          }
          if (tried.has(workspaceId)) {
            continue
          }
          tried.add(workspaceId)
          child = fetchLinearIssue(intent.identifier, workspaceId, { sourceContext }).acquire(
            current
          )
          const candidate = child
          const terminal = await candidate.waitForCurrentTerminal()
          if (!current()) {
            return true
          }
          if (terminal.kind === 'abandoned') {
            view = terminal
            notify()
            return true
          }
          if (
            terminal.kind === 'data' &&
            terminal.data &&
            isLinearIssueUrlResolutionMatch(intent, terminal.data)
          ) {
            const update = () => {
              childView = candidate.currentView()
              view =
                childView.kind === 'data'
                  ? {
                      kind: 'data',
                      data:
                        childView.data && isLinearIssueUrlResolutionMatch(intent, childView.data)
                          ? childView.data
                          : null
                    }
                  : childView
              notify()
            }
            unsubscribe = candidate.subscribe(update)
            update()
            return true
          }
          if (terminal.kind === 'error' && isIntegrationCredentialDecryptionError(terminal.error)) {
            credentialFailure = true
          }
          candidate.release()
          child = null
        }
        return false
      }
      void (async () => {
        if (await lookup(knownStatus)) {
          return
        }
        const status = await readLinearStatus(sourceContext).catch(() => null)
        if (!current() || (status && (await lookup(status)))) {
          return
        }
        view = credentialFailure
          ? { kind: 'error', error: new Error(credentialDecryptionMessage('Linear')), data: null }
          : { kind: 'data', data: null }
        notify()
      })().catch((error: unknown) => {
        if (current()) {
          view = { kind: 'error', error, data: null }
          notify()
        }
      })
      return {
        currentView: () => (current() ? view : { kind: 'abandoned', data: null }),
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        commit: (expected, previous, reduce) =>
          current() &&
          expected === view &&
          (!child || (childView && child.commit(childView, false, () => true)))
            ? reduce(previous, expected.data)
            : previous,
        waitForCurrentTerminal: () =>
          new Promise((resolve) => {
            const finish = () => {
              if (!current() || view.kind !== 'loading') {
                listeners.delete(finish)
                resolve(current() ? view : { kind: 'abandoned', data: null })
              }
            }
            listeners.add(finish)
            finish()
          }),
        release: () => {
          live = false
          notify()
          listeners.clear()
          unsubscribe()
          child?.release()
        }
      }
    }
  }
}
