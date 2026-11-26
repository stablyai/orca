import type {
  NgitMutationResult,
  NgitStatusAction,
  NgitViewer,
  NgitWorkItem,
  NgitWorkItemDetails,
  NgitWorkItemList,
  NgitWorktreeBaseResult
} from '../../../../shared/ngit/ngit-work-item-types'
import { getRepoExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { Repo } from '../../../../shared/repository/repo-types'
import { callRuntimeRpc } from '../rpc/calls/runtime-rpc-call'
import { forgeCredentialTarget } from '../source-control/forge/forge-credential-target'

// A first read may resolve a NIP-05 name and wait out slow relays.
const READ_TIMEOUT_MS = 60_000
// `ngit` fetches, signs and publishes before it answers.
const WRITE_TIMEOUT_MS = 200_000

type NgitParams = Record<string, string | boolean>

/** The ngit API on the machine that holds the repo, its relay cache and its `ngit` sign-in. */
export function ngitApiFor(repo: Repo) {
  const target = forgeCredentialTarget({ repoOwnerExecutionHostId: getRepoExecutionHostId(repo) })
  const call = <T>(method: string, params: NgitParams, timeoutMs = READ_TIMEOUT_MS): Promise<T> =>
    callRuntimeRpc<T>(target, method, { repo: `id:${repo.id}`, ...params }, { timeoutMs })
  const write = (method: string, params: NgitParams): Promise<NgitMutationResult> =>
    call<NgitMutationResult>(method, params, WRITE_TIMEOUT_MS)
  return {
    listWorkItems: (force: boolean) => call<NgitWorkItemList>('ngit.listWorkItems', { force }),
    workItemDetails: (eventId: string, force: boolean) =>
      call<NgitWorkItemDetails | null>('ngit.workItemDetails', { eventId, force }),
    createIssue: (title: string, body: string) => write('ngit.createIssue', { title, body }),
    addComment: (type: NgitWorkItem['type'], eventId: string, body: string) =>
      write('ngit.addComment', { type, eventId, body }),
    setStatus: (type: NgitWorkItem['type'], eventId: string, action: NgitStatusAction) =>
      write('ngit.setStatus', { type, eventId, action }),
    resolvePrBase: (eventId: string) =>
      call<NgitWorktreeBaseResult>('ngit.resolvePrBase', { eventId }, WRITE_TIMEOUT_MS),
    viewer: () => call<NgitViewer>('ngit.viewer', {})
  }
}
