import { defineFixture } from '../../component-fixtures/component-fixture'
import {
  CLOUD_LOG,
  CLOUD_RECIPE,
  entry,
  frame,
  seedFixtureRepo,
  stubBillingRole,
  T0
} from './vm-build-sheet-fixture-support'

// CLONE-ACCESS-ERROR: GitHub refused the clone of stablyai/orca-plugins. The card names the cause and
// fixes access, by what GitHub says about Orca's access now.

const REPO = 'https://github.com/stablyai/orca-plugins.git'

function cloneRefused(access: 'missing' | 'requested' | 'granted', interact?: boolean) {
  const fixture = frame(
    entry(
      {
        status: 'error',
        errorCode: 'cloudCloneFailed',
        provisioningLog: `${CLOUD_LOG}\nOrca Cloud: repo_unreachable`,
        errorAt: T0 + 2_000
      },
      CLOUD_RECIPE
    ),
    'Couldn’t clone stablyai/orca-plugins.',
    T0 + 2_000
  )
  return defineFixture({
    ...fixture,
    setup: () => {
      seedFixtureRepo(REPO)
      stubBillingRole(true)
      window.api.orcaCloudWorkspace = {
        ...window.api.orcaCloudWorkspace,
        getRepoAccess: async () => ({
          ok: true,
          value: { access, owner: 'stablyai', repo: 'https://github.com/stablyai/orca-plugins' }
        }),
        connectGitHub: async () => ({ ok: true, value: null })
      }
    },
    ...(interact
      ? {
          interact: async (frameElement: HTMLElement) => {
            await new Promise((resolve) => setTimeout(resolve, 300))
            const button = [...frameElement.querySelectorAll('button')].find(
              (candidate) => candidate.textContent?.trim() === 'Give Orca access'
            )
            button?.click()
            await new Promise((resolve) => setTimeout(resolve, 300))
          }
        }
      : {})
  })
}

/** The App doesn't reach the repository: Give Orca access, or choose another. */
export const accessMissing = cloneRefused('missing')
/** Back from GitHub's page, re-checking until access lands (then the create starts again). */
export const accessWaiting = cloneRefused('missing', true)
/** GitHub made the install a request for an owner: say who to ask, with a message to send. */
export const accessRequested = cloneRefused('requested')
/** Orca can reach it now: the clone failed for another reason. */
export const accessReachable = cloneRefused('granted')
