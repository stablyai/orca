import { z } from 'zod'

/**
 * Remote kill switch for WSL hosts. `block` closes the internal gate on the next launch, so saved
 * hosts and moved projects stay served (`serve-only`) while nothing new is added or moved.
 */
export const WSL_HOSTS_POLICY_MAX_BYTES = 16 * 1024

// Not strict: a field added later must not make older builds drop the whole policy.
const WslHostsPolicySchema = z.object({
  version: z.literal(1),
  /** Monotonic: a lower or equal revision never replaces the cached one. */
  revision: z.number().int().positive(),
  wslHosts: z.enum(['allow', 'block']),
  /**
   * With `block` only: `bring-back` returns already-moved projects to this computer. An unknown
   * value reads as absent (`keep`), so a later value never drops the block itself.
   */
  movedProjects: z.enum(['keep', 'bring-back']).optional().catch(undefined)
})

export type WslHostsPolicy = z.infer<typeof WslHostsPolicySchema>

export type WslHostsPolicyParse =
  | { ok: true; policy: WslHostsPolicy }
  | { ok: false; error: string }

export function parseWslHostsPolicy(text: string): WslHostsPolicyParse {
  if (new TextEncoder().encode(text).byteLength > WSL_HOSTS_POLICY_MAX_BYTES) {
    return { ok: false, error: `larger than ${WSL_HOSTS_POLICY_MAX_BYTES} bytes` }
  }
  try {
    return { ok: true, policy: WslHostsPolicySchema.parse(JSON.parse(text)) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** `missing` (none cached, or unreadable) blocks nothing: the local gate alone decides. */
export type WslHostsPolicyState = 'allow' | 'block' | 'missing'

export function wslHostsPolicyState(policy: WslHostsPolicy | null): WslHostsPolicyState {
  return policy?.wslHosts ?? 'missing'
}

export type WslHostsMovedProjects = 'keep' | 'bring-back'

/** `keep` unless the policy blocks and asks for moved projects back. */
export function wslHostsPolicyMovedProjects(policy: WslHostsPolicy | null): WslHostsMovedProjects {
  return policy?.wslHosts === 'block' && policy.movedProjects === 'bring-back'
    ? 'bring-back'
    : 'keep'
}
