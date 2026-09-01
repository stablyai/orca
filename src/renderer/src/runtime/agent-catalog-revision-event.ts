// Why: the runtime client-event stream is owned by renderer hooks, but the paired-web
// catalog cache lives in the preload shim, which renderer code must never import (it
// would pull the browser shim into the desktop bundle). A window event bridges them;
// on desktop nothing subscribes and the announcement is inert.

export const AGENT_CATALOG_REVISION_EVENT = 'orca:agent-catalog-revision'

export function emitAgentCatalogRevision(revision: number): void {
  window.dispatchEvent(new CustomEvent(AGENT_CATALOG_REVISION_EVENT, { detail: { revision } }))
}

export function subscribeAgentCatalogRevision(onRevision: (revision: number) => void): () => void {
  const listener = (event: Event): void => {
    const revision = (event as CustomEvent<{ revision?: unknown }>).detail?.revision
    if (typeof revision === 'number') {
      onRevision(revision)
    }
  }
  window.addEventListener(AGENT_CATALOG_REVISION_EVENT, listener)
  return () => {
    window.removeEventListener(AGENT_CATALOG_REVISION_EVENT, listener)
  }
}
