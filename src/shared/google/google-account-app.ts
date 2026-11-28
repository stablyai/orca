import type { GoogleClientView } from './google-client-config'
import type { GoogleAccountView } from './google-connect-types'

/**
 * The app an account's API links and admin requests name: the one it signed in through, which may
 * not be this computer's app now. An older host doesn't say, and its accounts use this computer's.
 */
export function googleAccountApp(
  account: Pick<GoogleAccountView, 'app'>,
  client: Pick<GoogleClientView, 'clientId' | 'projectId'> | null
): { clientId: string | null; projectId: string | null } {
  const app = account.app ?? client
  return { clientId: app?.clientId ?? null, projectId: app?.projectId ?? null }
}
