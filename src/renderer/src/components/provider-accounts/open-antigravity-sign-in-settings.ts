import { openProviderAccountSettings } from './open-provider-account-settings'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'

/** Opens Settings › AI Provider Accounts › Antigravity on the chat's host, where sign-in lives. */
export function openAntigravitySignInSettings(host: RuntimeClientTarget | undefined): void {
  openProviderAccountSettings('antigravity', host)
}
