import { useAppStore } from '../../../index'
import { createRuntimeStatusSubscriptions } from './runtime-status-subscriptions'

let subscriptions: ReturnType<typeof createRuntimeStatusSubscriptions> | undefined
const current = () => (subscriptions ??= createRuntimeStatusSubscriptions(useAppStore))

export const runtimeStatusSubscriptions: ReturnType<typeof createRuntimeStatusSubscriptions> = {
  getConnectionSnapshot: (id) => current().getConnectionSnapshot(id),
  subscribeConnection: (id, listener) => current().subscribeConnection(id, listener),
  getHostSnapshot: (id) => current().getHostSnapshot(id),
  subscribeHostLifetime: (id, listener) => current().subscribeHostLifetime(id, listener),
  getParkingSnapshot: () => current().getParkingSnapshot(),
  subscribeParking: (listener) => current().subscribeParking(listener)
}
