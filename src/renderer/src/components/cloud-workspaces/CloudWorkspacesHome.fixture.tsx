import { defineFixture } from '../../component-fixtures/component-fixture'
import { CloudWorkspacesHome } from './CloudWorkspacesHome'
import {
  AUTH_STATUS,
  stubCloudWorkspacesApi,
  teamWorkspaces,
  workspace
} from './cloud-workspaces.test-fixture'

const WIDTH = 760

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 3000
  while (!check() && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** Team scope: two sections, five owners, every lifecycle state, presence, cost and a private row. */
export const teamList = defineFixture({
  width: WIDTH,
  store: { orcaProfileAuthStatus: AUTH_STATUS },
  setup: () => {
    const rows = teamWorkspaces()
    stubCloudWorkspacesApi(() => Promise.resolve({ ok: true, value: rows }))
  },
  render: () => <CloudWorkspacesHome />,
  interact: () => waitFor(() => document.querySelector('[data-cloud-workspace-row]') !== null)
})

/** A link pointed at this row; Home rings it while it opens. */
export const highlightedFromLink = defineFixture({
  width: WIDTH,
  store: { orcaProfileAuthStatus: AUTH_STATUS },
  setup: () => {
    const rows = [workspace({ title: 'Checkout retries', id: 'sbx_00000000000000000000beef' })]
    stubCloudWorkspacesApi(() => Promise.resolve({ ok: true, value: rows }))
  },
  render: () => <CloudWorkspacesHome highlightId="sbx_00000000000000000000beef" />,
  interact: () => waitFor(() => document.querySelector('[data-cloud-workspace-row]') !== null)
})

/** First read still in flight: Skeleton rows shaped like real ones. */
export const loading = defineFixture({
  width: WIDTH,
  store: { orcaProfileAuthStatus: AUTH_STATUS },
  setup: () => stubCloudWorkspacesApi(() => new Promise(() => {})),
  render: () => <CloudWorkspacesHome />,
  interact: () => waitFor(() => document.querySelector('[data-slot="skeleton"]') !== null)
})

/** The list could not be read: InlineError with Retry. */
export const error = defineFixture({
  width: WIDTH,
  store: { orcaProfileAuthStatus: AUTH_STATUS },
  setup: () => stubCloudWorkspacesApi(() => Promise.resolve({ ok: false, error: 'unavailable' })),
  render: () => <CloudWorkspacesHome />,
  interact: () => waitFor(() => document.querySelector('[data-slot="inline-error"]') !== null)
})

/** Signed in, nothing shared yet. */
export const emptyTeam = defineFixture({
  width: WIDTH,
  store: { orcaProfileAuthStatus: AUTH_STATUS },
  setup: () => stubCloudWorkspacesApi(() => Promise.resolve({ ok: true, value: [] })),
  render: () => <CloudWorkspacesHome />,
  interact: () => waitFor(() => document.querySelector('section p') !== null)
})
