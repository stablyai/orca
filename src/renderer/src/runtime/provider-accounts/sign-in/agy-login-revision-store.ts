import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { createRevisionedHostStateStore } from '../../hosts/observations/revisioned-host-state-store'
import { subscribeAntigravityLoginChanges } from './runtime-antigravity-accounts-client'

const hostKey = (owner: RuntimeClientTarget): string =>
  owner.kind === 'local' ? '' : owner.environmentId

const frameRevision = (result: unknown): number | null =>
  typeof result === 'object' &&
  result !== null &&
  'loginRevision' in result &&
  typeof result.loginRevision === 'number'
    ? result.loginRevision
    : null

/** Per host, how many times agy's stored login has changed; one stream however many rows follow,
 *  opened again after a lost connection. */
export const agyLoginRevisions = createRevisionedHostStateStore<
  RuntimeClientTarget,
  { revision: number }
>({
  key: hostKey,
  hostKey,
  subscribe: (owner, handlers) =>
    subscribeAntigravityLoginChanges(owner, {
      ...handlers,
      onEvent: (result, runtimeId) => {
        const revision = frameRevision(result)
        if (revision !== null) {
          handlers.onEvent({ revision }, runtimeId)
        }
      }
    })
})
