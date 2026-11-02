import { getHostOperationOwnership } from '../../../shared/host-operation-ownership'
import { callRuntimeRpc } from './runtime-rpc-client'
import type { HostRoute } from './runtime-client-target'
import { captureHostIdentityFence, isHostIdentityFenceCurrent } from '@/store/host-catalog-fencing'

/** The host behind the route changed while the call was in flight; it may or may not have run. */
export class HostRouteUnverifiableError extends Error {
  readonly verdict = 'unverifiable'
  constructor(readonly method: string) {
    super(`The host changed while ${method} was in flight; refresh to see whether it ran.`)
    this.name = 'HostRouteUnverifiableError'
  }
}

type HostRouteCallOptions = Pick<
  NonNullable<Parameters<typeof callRuntimeRpc>[3]>,
  'timeoutMs' | 'signal' | 'expectedEnvironmentRuntimeId'
>

/**
 * Calls a host-owned method on the host the route names. Params stay endpoint-relative: the domain
 * adapter derives them from the same resource ref as the route. A reply whose identity fence moved
 * is never applied or retried; snapshot readers add their own data fence on top.
 */
export async function callHostRoute<TResult>(
  route: HostRoute,
  method: string,
  params?: unknown,
  options: HostRouteCallOptions = {}
): Promise<TResult> {
  const ownership = getHostOperationOwnership(method)
  if (ownership === null || ownership === 'client') {
    throw new Error(`${method} is not a host-owned operation`)
  }
  const fence = captureHostIdentityFence(route)
  const result = await callRuntimeRpc<TResult>(route.target, method, params, {
    ...options,
    expectedEnvironmentPairingRevision: fence.pairingRevision
  })
  if (!isHostIdentityFenceCurrent(fence)) {
    throw new HostRouteUnverifiableError(method)
  }
  return result
}
