import { expect, test } from 'vitest'
import { EnsureAgentSessionParams } from '../../../src/shared/rpc-contract/agent-session-params'
import { normalizeAgentStatusPayload } from '../../../src/shared/agent-status-types'
import { importReleaseCheckoutModule, materializeReleaseCheckout } from './release-checkout'

test.each(['v1.4.205', 'v1.4.211'])(
  'release %s preserves new provider status tags but refuses unsupported resume',
  async (ref) => {
    const checkout = await materializeReleaseCheckout(ref)
    const baselineStatus = await importReleaseCheckoutModule(
      checkout,
      'src/shared/agent-status-types.ts'
    )
    const normalize = baselineStatus.normalizeAgentStatusPayload
    if (typeof normalize !== 'function') {
      throw new Error('Pinned release has no status normalizer')
    }
    const baselineResume = await importReleaseCheckoutModule(
      checkout,
      'src/shared/rpc-contract/agent-session-params.ts'
    )
    const schema = baselineResume.EnsureAgentSessionParams
    if (
      !schema ||
      typeof schema !== 'object' ||
      !('safeParse' in schema) ||
      typeof schema.safeParse !== 'function'
    ) {
      throw new Error('Pinned release has no resume request parser')
    }
    for (const agent of ['qoder-cn', 'qwen-code'] as const) {
      const status = { state: 'working', agentType: agent }
      expect(normalize(status)).toMatchObject(status)
      expect(normalizeAgentStatusPayload(status)).toMatchObject(status)
      const request = {
        kind: 'explicit',
        worktree: 'folder:/task-owned/folder',
        agent,
        providerSession: { key: 'session_id', id: 'test-session' }
      }
      expect(EnsureAgentSessionParams.safeParse(request).success).toBe(true)
      expect(schema.safeParse(request)).toHaveProperty('success', false)
    }
  },
  120_000
)
