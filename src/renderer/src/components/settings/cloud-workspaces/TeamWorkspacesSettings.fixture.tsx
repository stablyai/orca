// Settings › Workspaces (team owners and admins): the team's cloud workspaces as a table with By,
// In and search, and each row's allowed actions.
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { TeamWorkspacesSettings } from './TeamWorkspacesSettings'
import {
  AUTH_STATUS,
  stubCloudWorkspacesApi,
  teamWorkspaces
} from '../../cloud-workspaces/cloud-workspaces.test-fixture'

const WIDTH = 820

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 3000
  while (!check() && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const frame = (): React.JSX.Element => (
  <div className="h-[560px] bg-background p-6">
    <TeamWorkspacesSettings orgId="org_acme" />
  </div>
)

/** Every lifecycle state (running, starting, waking, asleep, couldn't start, archived), five people. */
export const teamTable = defineFixture({
  width: WIDTH,
  store: { orcaProfileAuthStatus: AUTH_STATUS },
  setup: () => stubCloudWorkspacesApi(() => Promise.resolve({ ok: true, value: teamWorkspaces() })),
  render: frame,
  interact: () => waitFor(() => document.querySelector('[data-team-workspace-row]') !== null)
})

/** A running teammate workspace's ⋯: Open, Sleep, Archive (nothing the server would refuse). */
export const rowActions = defineFixture({
  width: WIDTH,
  store: { orcaProfileAuthStatus: AUTH_STATUS },
  setup: () => stubCloudWorkspacesApi(() => Promise.resolve({ ok: true, value: teamWorkspaces() })),
  render: frame,
  interact: async () => {
    await waitFor(() => document.querySelector('[data-team-workspace-row]') !== null)
    const trigger = document.querySelector<HTMLElement>(
      '[data-team-workspace-row] [data-slot="dropdown-menu-trigger"]'
    )
    trigger?.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })
    )
    await waitFor(() => document.querySelector('[data-slot="dropdown-menu-content"]') !== null)
  }
})

/** Nobody on the team has started one. */
export const empty = defineFixture({
  width: WIDTH,
  store: { orcaProfileAuthStatus: AUTH_STATUS },
  setup: () => stubCloudWorkspacesApi(() => Promise.resolve({ ok: true, value: [] })),
  render: frame,
  interact: () => waitFor(() => document.querySelector('[data-team-workspaces] p') !== null)
})

/** The list could not be read. */
export const error = defineFixture({
  width: WIDTH,
  store: { orcaProfileAuthStatus: AUTH_STATUS },
  setup: () => stubCloudWorkspacesApi(() => Promise.resolve({ ok: false, error: 'unavailable' })),
  render: frame,
  interact: () => waitFor(() => document.querySelector('[data-slot="inline-error"]') !== null)
})
