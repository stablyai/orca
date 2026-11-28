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

let opened = 0

/** Per host, how many times agy's stored login has changed; one stream however many rows follow,
 *  opened again after a lost connection. `login` names the stream and its count, so a reopened
 *  stream, which can't say what changed while it was closed, reads as a change. */
export const agyLoginRevisions = createRevisionedHostStateStore<
  RuntimeClientTarget,
  { revision: number; login: string }
>({
  key: hostKey,
  hostKey,
  forgetUnobserved: true,
  subscribe: (owner, handlers) => {
    const stream = ++opened
    return subscribeAntigravityLoginChanges(owner, {
      ...handlers,
      onEvent: (result, runtimeId) => {
        const revision = frameRevision(result)
        if (revision !== null) {
          handlers.onEvent({ revision, login: `${stream}:${revision}` }, runtimeId)
        }
      }
    })
  }
})
