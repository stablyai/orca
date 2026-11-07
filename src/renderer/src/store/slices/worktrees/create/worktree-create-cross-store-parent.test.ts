import { describe, expect, it } from 'vitest'
import { RuntimeRpcCallError } from '../../../../runtime/runtime-rpc-result'
import type { CrossStoreParentRef } from '../../../../../../shared/worktree/lineage-types'
import { withoutRefusedInferredParent } from './worktree-create-cross-store-parent'

const refusal = (code: string) =>
  new RuntimeRpcCallError({
    id: '1',
    ok: false,
    error: { code, message: code },
    _meta: { runtimeId: 'r' }
  })
const parent: CrossStoreParentRef = {
  installationId: 'desktop',
  workspaceKey: 'folder:f-1',
  instanceId: 'f-1'
}

describe('withoutRefusedInferredParent', () => {
  it('drops an inferred parent the server refused, so the create retries unnested', () => {
    expect(
      withoutRefusedInferredParent(
        {
          name: 'w',
          crossStoreParent: parent,
          crossStoreParentInferredFrom: 'orchestration-context'
        },
        refusal('LINEAGE_PARENT_CONTEXT_CONFLICT')
      )
    ).toEqual({ name: 'w' })
  })

  it('never retries a picked parent or a create that failed otherwise', () => {
    expect(
      withoutRefusedInferredParent(
        { name: 'w', crossStoreParent: parent },
        refusal('LINEAGE_PARENT_CONTEXT_CONFLICT')
      )
    ).toBeNull()
    expect(
      withoutRefusedInferredParent(
        {
          name: 'w',
          crossStoreParent: parent,
          crossStoreParentInferredFrom: 'orchestration-context'
        },
        refusal('runtime_timeout')
      )
    ).toBeNull()
  })
})
