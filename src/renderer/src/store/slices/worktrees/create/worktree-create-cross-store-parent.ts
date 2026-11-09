import type { AppState } from '../../../types'
import { buildCrossStoreParentRef } from '../metadata/cross-store-parent-ref'
import type { WorktreeCreateParentPick } from './worktree-create-parent-pick'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import type { RuntimeStatus } from '../../../../../../shared/runtime-types'
import type {
  CrossStoreInferredSource,
  CrossStoreParentRef
} from '../../../../../../shared/worktree/lineage-types'
import { supportsCrossStoreLineage } from '../../../../../../shared/worktree-runtime-capabilities'
import { callRuntimeRpc } from '../../../../runtime/rpc/calls/runtime-rpc-call'
import { RuntimeRpcCallError } from '../../../../runtime/rpc/calls/runtime-rpc-result'

/** The CLI's budget for caller inference: optional nesting never holds up the create. */
const NOTE_PARENT_INFERENCE_BUDGET_MS = 3_000
const TASK_ID = /\btask_[A-Za-z0-9]+\b/
const LOCAL_TARGET: RuntimeClientTarget = { kind: 'local' }

/**
 * A create's parent in another store. A picked parent refuses the whole create (older Orca,
 * unconfirmed parent) rather than create it unnested; the active folder fallback keeps its old
 * behaviour there: create unnested and warn. Only when nothing else named a parent, even one since
 * dropped, may a task id in the note name one.
 */
export async function resolveCreateCrossStoreParent(
  state: AppState,
  target: RuntimeClientTarget,
  create: {
    pick: WorktreeCreateParentPick
    requestedParentWorktreeId: string | undefined
    note: string | undefined
    warnParentDropped: () => void
  }
): Promise<Partial<InferredNoteParent>> {
  const { pick } = create
  if (pick.crossStoreParentRow) {
    try {
      return {
        crossStoreParent: await buildCrossStoreParentRef(state, target, pick.crossStoreParentRow)
      }
    } catch (error) {
      if (!pick.crossStoreParentIsActiveFolder) {
        throw error
      }
      create.warnParentDropped()
      return {}
    }
  }
  if (pick.parentWorkspace || create.requestedParentWorktreeId) {
    return {}
  }
  return (await inferNoteCrossStoreParent(target, create.note)) ?? {}
}

type InferredNoteParent = {
  crossStoreParent: CrossStoreParentRef
  crossStoreParentInferredFrom: CrossStoreInferredSource
}

/**
 * A workspace created on a paired server whose note names a task: the task lives in this desktop's
 * own Orca, so this desktop names the parent, as the CLI does for its caller's context. The whole
 * step shares one 3 s deadline; anything short of a confirmed parent creates unnested, as before.
 */
async function inferNoteCrossStoreParent(
  target: RuntimeClientTarget,
  note: string | undefined
): Promise<InferredNoteParent | undefined> {
  if (target.kind !== 'environment' || !note || !TASK_ID.test(note)) {
    return undefined
  }
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve(undefined)
    }, NOTE_PARENT_INFERENCE_BUDGET_MS)
  })
  try {
    return await Promise.race([deadline, inferWithin(target, note, controller.signal)])
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

async function inferWithin(
  target: RuntimeClientTarget,
  note: string,
  signal: AbortSignal
): Promise<InferredNoteParent | undefined> {
  const status = await callRuntimeRpc<RuntimeStatus>(target, 'status.get', undefined, { signal })
  const serverInstallationId = status.hostDescriptor?.installationId
  if (!serverInstallationId || !supportsCrossStoreLineage(status.capabilities)) {
    return undefined
  }
  const resolved = await callRuntimeRpc<
    { parent: CrossStoreParentRef; source: CrossStoreInferredSource } | { reason: string }
  >(LOCAL_TARGET, 'worktree.resolveCallerParent', { comment: note }, { signal })
  // A client whose own Orca is this server has nothing to add: the server reads the note itself.
  if ('reason' in resolved || resolved.parent.installationId === serverInstallationId) {
    return undefined
  }
  return { crossStoreParent: resolved.parent, crossStoreParentInferredFrom: resolved.source }
}

/** The attempt without its inferred parent when the server refused that parent, which it checks
 * before creating anything: optional nesting never fails the create. Null for any other failure,
 * timeouts included. */
export function withoutRefusedInferredParent<T extends Partial<InferredNoteParent>>(
  attempt: T,
  error: unknown
): Omit<T, keyof InferredNoteParent> | null {
  if (
    !attempt.crossStoreParentInferredFrom ||
    !(error instanceof RuntimeRpcCallError && error.code.startsWith('LINEAGE_'))
  ) {
    return null
  }
  const { crossStoreParent: _parent, crossStoreParentInferredFrom: _source, ...unnested } = attempt
  return unnested
}
