import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { ConfirmationDialogProvider } from '@/components/confirmation-dialog'
import type { OrcaProfileAuthStatus } from '../../../../../../shared/orca-profiles'
import type { GitHubIdentityState } from './github-identity-model'
import { GitHubIdentityRowView } from './GitHubIdentityRow'
import { OrcaAccountSettingsPane } from './OrcaAccountSettingsPane'

const width = 760
const noop = (): void => {}

/** The row as it sits under the signed-in identity in Account & billing. */
function row(state: GitHubIdentityState) {
  return defineFixture({
    width,
    render: () => (
      <div className="bg-background px-8 py-6">
        <GitHubIdentityRowView
          state={state}
          onConnect={noop}
          onCancel={noop}
          onDisconnect={noop}
          onRetryDisconnect={noop}
        />
      </div>
    )
  })
}

/** Not connected: why to connect, and Connect GitHub. */
export const notConnected = row({ kind: 'disconnected' })

/** Connect opened the browser: a spinner, and a quiet Cancel back to not connected. */
export const pending = row({ kind: 'pending' })

/** Connected: the GitHub mark (no avatar; the renderer doesn't load them by user id), and Disconnect. */
export const connected = row({ kind: 'connected', login: 'octocat', githubUserId: 583231 })

/** A confirmed Disconnect failed: still connected, and Try again re-runs it without asking. */
export const connectedDisconnectFailed = row({
  kind: 'connected',
  login: 'octocat',
  githubUserId: 583231,
  disconnectFailed: true
})

/** Connect failed, or the browser never finished: Try again. */
export const error = row({ kind: 'error' })

const signedIn: OrcaProfileAuthStatus = {
  activeProfileId: 'local-default',
  configured: true,
  state: 'connected',
  persistence: 'encrypted',
  cloud: {
    cloudProfileId: 'fixture',
    userId: 'fixture-user',
    email: 'ada@example.com',
    displayName: 'Ada Lovelace',
    activeOrgId: 'org-eval',
    activeOrgName: 'Orca Staging Eval Team',
    linkedAt: 0
  }
}

async function openDisconnectConfirm(frame: HTMLElement): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const button = Array.from(frame.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.trim() === 'Disconnect'
    )
    if (button) {
      button.click()
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** Disconnect asks first, in the shared confirm dialog, over the real account pane. */
export const disconnectConfirm = defineFixture({
  width,
  store: { orcaProfileAuthStatus: signedIn },
  setup: () => {
    Object.assign(window.api.orcaProfiles, { authStatus: () => Promise.resolve(signedIn) })
    Object.assign(window.api, {
      cloudApi: {
        ...window.api.cloudApi,
        availability: () =>
          Promise.resolve({ status: 'ready' as const, controlPlaneUrl: 'https://cloud.example' })
      }
    })
    // The web preload has no orcaCloudWorkspace; give the pane the one call it makes.
    Object.assign(window.api, {
      orcaCloudWorkspace: {
        getGitHubUser: () =>
          Promise.resolve({
            ok: true,
            value: { connected: true, login: 'octocat', githubUserId: 583231 }
          })
      }
    })
  },
  render: () => (
    <div className="h-[360px] bg-background px-8 py-6">
      <ConfirmationDialogProvider>
        <OrcaAccountSettingsPane />
      </ConfirmationDialogProvider>
    </div>
  ),
  interact: openDisconnectConfirm
})
