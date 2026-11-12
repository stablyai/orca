// V3-08: Home signed out of Orca. Cloud builds with projects show the "Cloud workspaces · Sign in"
// card where the list would be; without projects, and in local builds, Home is unchanged.
import type { Repo } from '../../../../shared/repo-types'
import type { OrcaProfileAuthStatus } from '../../../../shared/orca-profiles'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { resetCloudWorkspacesAvailabilityForFixtures } from '../cloud-workspaces/use-cloud-workspaces'
import { makeRepo } from '../worktree-jump/worktree-jump-palette-test-fixtures'
import Landing from '../Landing'

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
// A healthy machine, so the shots show only Home's cloud area.
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
