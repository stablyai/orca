import type { WebAiAccount } from '../../../shared/types'

export type BrowserProfileOperationOwner = {
  // null is an explicit local owner; an omitted owner preserves the ordinary
  // settings-focused runtime behavior.
  runtimeEnvironmentId: string | null
}

const LOCAL_BROWSER_PROFILE_OPERATION_OWNER: BrowserProfileOperationOwner = {
  runtimeEnvironmentId: null
}

export function getWebAiBrowserProfileOperationOwner(
  account: WebAiAccount | null
): BrowserProfileOperationOwner | undefined {
  // Why: Web AI identities are Electron-local. Restored page metadata must not
  // be able to redirect cookie/profile operations to a focused remote runtime.
  return account ? LOCAL_BROWSER_PROFILE_OPERATION_OWNER : undefined
}
