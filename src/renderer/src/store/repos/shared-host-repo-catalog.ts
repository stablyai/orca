// What the repo catalog does when shares arrive or end: an ended share's host goes as a removed
// paired server's does, and the catalog is republished so every Projects, picker and settings reader
// (each keyed on `repos`) re-reads which hosts' projects are kept out.
import type { SharedBotHostsChanged } from '@/runtime/hosts/shared-bot-hosts/shared-bot-host-catalog'
import type { AppState } from '../types'

type RepoCatalogStore = {
  getState: () => Pick<AppState, 'purgeStaleRuntimeHostState'>
  setState: (update: (state: AppState) => Partial<AppState>) => void
}

export function followSharedHostsInRepoCatalog(store: RepoCatalogStore): SharedBotHostsChanged {
  return (endedEnvironmentIds) => {
    if (endedEnvironmentIds.length > 0) {
      store.getState().purgeStaleRuntimeHostState(endedEnvironmentIds)
    }
    store.setState((state) => ({ repos: [...state.repos] }))
  }
}
