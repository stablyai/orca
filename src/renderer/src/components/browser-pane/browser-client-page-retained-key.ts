import type { BrowserClientPageRendererIdentity } from '../../../../shared/browser-client-page-renderer-protocol'

export function browserClientPageRetainedKey(identity: BrowserClientPageRendererIdentity): string {
  return JSON.stringify([identity.partition, identity.browserPageId, identity.pageHostGeneration])
}
