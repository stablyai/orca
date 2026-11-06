import type { AppState } from '../../../types'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import type { RuntimeStatus } from '../../../../../../shared/runtime-types'
import type {
  CrossStoreInferredSource,
  CrossStoreParentRef
} from '../../../../../../shared/worktree/lineage-types'
import { supportsCrossStoreLineage } from '../../../../../../shared/worktree-runtime-capabilities'
import { callRuntimeRpc } from '../../../../runtime/runtime-rpc-client'
import { selectLineageStoreInstallationId } from '../../../cross-store-lineage-parents'
import { lineageStoreKeyOfTarget } from '../metadata/cross-store-lineage-state'

/** The CLI's budget for asking this machine's Orca: optional nesting never holds up the create. */
const NOTE_PARENT_INFERENCE_BUDGET_MS = 3_000
const TASK_ID = /\btask_[A-Za-z0-9]+\b/
const LOCAL_TARGET: RuntimeClientTarget = { kind: 'local' }

type InferredNoteParent = {
  crossStoreParent: CrossStoreParentRef
  crossStoreParentInferredFrom: CrossStoreInferredSource
}

/**
 * A workspace created on a paired server whose note names a task: the task lives in this desktop's
 * own Orca, so this desktop names the parent, as the CLI does for its caller's context. Anything
 * short of a confirmed parent (no capability, timeout, error, no task) creates unnested, as before.
 */
export async function inferNoteCrossStoreParent(
  state: AppState,
  target: RuntimeClientTarget,
  note: string | undefined
): Promise<InferredNoteParent | undefined> {
  if (target.kind !== 'environment' || !note || !TASK_ID.test(note)) {
    return undefined
  }
  // A client whose own Orca is this server has nothing to add: the server reads the note itself.
  const serverInstallationId = selectLineageStoreInstallationId(
    state,
    lineageStoreKeyOfTarget(target)
  )
  if (!serverInstallationId) {
    return undefined
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const status = await callRuntimeRpc<RuntimeStatus>(target, 'status.get')
    if (!supportsCrossStoreLineage(status.capabilities)) {
      return undefined
    }
    const timedOut = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), NOTE_PARENT_INFERENCE_BUDGET_MS)
    })
    const resolved = await Promise.race([
      callRuntimeRpc<
        { parent: CrossStoreParentRef; source: CrossStoreInferredSource } | { reason: string }
      >(LOCAL_TARGET, 'worktree.resolveCallerParent', { comment: note }),
      timedOut
    ])
    if (!resolved || 'reason' in resolved) {
      return undefined
    }
    if (resolved.parent.installationId === serverInstallationId) {
      return undefined
    }
    return {
      crossStoreParent: resolved.parent,
      crossStoreParentInferredFrom: resolved.source
    }
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}
