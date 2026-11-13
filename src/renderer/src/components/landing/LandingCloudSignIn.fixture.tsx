// V3-08: Landing signed out of Orca. Cloud builds with projects show the "Cloud workspaces · Sign in"
// card; without projects, and in local builds, Landing is unchanged. Signed in, Landing is
// upstream's, and Add project opens the sidebar's Add project menu.
import type { Repo } from '../../../../shared/repo-types'
import type { OrcaProfileAuthStatus } from '../../../../shared/orca-profiles'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { resetCloudWorkspacesAvailabilityForFixtures } from '../cloud-workspaces/use-cloud-workspaces'
import { makeRepo } from '../worktree-jump/worktree-jump-palette-test-fixtures'
import Landing from '../Landing'
import { AUTH_STATUS } from '../cloud-workspaces/cloud-workspaces.test-fixture'

const repo: Repo = { ...makeRepo(), displayName: 'orca' }
const auth = (
  configured: boolean,
  state: OrcaProfileAuthStatus['state']
): OrcaProfileAuthStatus => ({ activeProfileId: 'default', configured, state, persistence: 'none' })
const signedOut = auth(true, 'local')
const sessionEnded = auth(true, 'reconnect-required')
const localBuild = auth(false, 'unconfigured')

const build = (cloud: boolean) => (): void => {
  window.api.cloudWorkspaces = { ...window.api.cloudWorkspaces, available: async () => cloud }
  resetCloudWorkspacesAvailabilityForFixtures()
}
// A healthy machine, so the shots show only Landing's cloud area.
const healthy = {
  preflightStatus: {
    git: { installed: true },
    gh: { installed: true, authenticated: true },
    glab: { installed: true, authenticated: true }
  },
  refreshPreflightStatus: async () => {}
}

const home = (): React.JSX.Element => (
  <div className="relative" style={{ height: 620 }}>
    <Landing />
  </div>
)

/** Cloud build, signed out, has projects: the sign-in card. */
export const cloudSignedOutWithProjects = defineFixture({
  width: 760,
  setup: build(true),
  store: { ...healthy, repos: [repo], orcaProfileAuthStatus: signedOut },
  render: home
})

/** Cloud build, the session ended: same card, "Sign in again". */
export const cloudSessionEndedWithProjects = defineFixture({
  width: 760,
  setup: build(true),
  store: { ...healthy, repos: [repo], orcaProfileAuthStatus: sessionEnded },
  render: home
})

/** Cloud build, signed out, no projects: unchanged (the welcome screen is V3-05, not built). */
export const cloudSignedOutNoProjects = defineFixture({
  width: 760,
  setup: build(true),
  store: { ...healthy, repos: [], orcaProfileAuthStatus: signedOut },
  render: home
})

/** Cloud build, signed in, has projects: Landing as upstream has it, no cloud list. */
export const cloudSignedInWithProjects = defineFixture({
  width: 760,
  setup: build(true),
  store: { ...healthy, repos: [repo], orcaProfileAuthStatus: AUTH_STATUS },
  render: home
})

/** Signed in: Add project opens the sidebar's Add project menu, with "Open cloud workspace…". */
export const addProjectMenuSignedIn = defineFixture({
  width: 760,
  setup: build(true),
  store: { ...healthy, repos: [repo], orcaProfileAuthStatus: AUTH_STATUS },
  render: home,
  interact: async (frame) => {
    const button = [...frame.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === 'Add project'
    )
    // Wait for the cloud availability probe so the Orca Cloud group is in the menu.
    await new Promise((resolve) => setTimeout(resolve, 150))
    button?.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        pointerType: 'mouse'
      })
    )
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
})

/** Local build with projects: unchanged, no cloud card. */
export const localBuildWithProjects = defineFixture({
  width: 760,
  setup: build(false),
  store: { ...healthy, repos: [repo], orcaProfileAuthStatus: localBuild },
  render: home
})

/** Local build, no projects: unchanged. */
export const localBuildNoProjects = defineFixture({
  width: 760,
  setup: build(false),
  store: { ...healthy, repos: [], orcaProfileAuthStatus: localBuild },
  render: home
})
