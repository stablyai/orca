import { defineFixture } from '../../component-fixtures/component-fixture'
import { CloudWorkspacesHome } from './CloudWorkspacesHome'
import {
  AUTH_STATUS,
  stubCloudWorkspacesApi,
  teamWorkspaces,
  workspace
} from './cloud-workspaces.test-fixture'
import type { CloudReadSnapshotState } from '../../../../shared/cloud-workspaces/read-snapshot-state'

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

const ASLEEP_ID = 'sbx_00000000000000000000a51e'

function stubAsleep(answer: () => Promise<CloudReadSnapshotState>): void {
  const rows = [
    workspace({
      id: ASLEEP_ID,
      title: 'Checkout retries',
      status: 'suspended',
      ownerUserId: 'user_grace',
      createdBy: 'user_grace',
      access: 'can_open'
    })
  ]
  stubCloudWorkspacesApi(() => Promise.resolve({ ok: true, value: rows }))
  Object.assign(window.api.cloudWorkspaces, {
    readSnapshot: async () => ({ ok: true as const, value: await answer() })
  })
}

async function openAsleepRow(): Promise<void> {
  await waitFor(() => document.querySelector('[data-cloud-workspace-row] button') !== null)
  document.querySelector<HTMLButtonElement>('[data-cloud-workspace-row] button')?.click()
  await waitFor(
    () =>
      document.querySelector('[data-cloud-read-view]:not([data-cloud-read-view="loading"])') !==
      null
  )
}

/** Clicking a teammate's Asleep row opens its read-only copy in a sheet (no wake). */
export const asleepReadView = defineFixture({
  width: WIDTH,
  store: { orcaProfileAuthStatus: AUTH_STATUS },
  setup: () =>
    stubAsleep(async () => ({
      state: 'ready',
      storedAt: Date.now() - 20 * 60_000,
      snapshot: {
        v: 1,
        workspaceId: ASLEEP_ID,
        snapshotId: 'snap_1',
        capturedAt: Date.now() - 20 * 60_000,
        reason: 'sleep',
        pr: {
          number: 412,
          title: 'Retry checkout webhooks with backoff',
          state: 'open',
          url: 'https://github.com/acme/web/pull/412',
          checksStatus: 'success',
          checksSummary: '9/9 passed'
        },
        git: {
          branch: 'checkout-retries',
          head: '3f95655',
          changeCount: 1,
          added: 88,
          removed: 19,
          changes: [
            {
              path: 'src/payments/webhooks.ts',
              status: 'modified',
              area: 'unstaged',
              added: 88,
              removed: 19
            }
          ],
          commits: []
        },
        sessions: [
          {
            sessionId: 's1',
            agent: 'claude',
            title: 'Retry failed checkout webhooks',
            status: 'idle',
            turnOutcome: 'done',
            updatedAt: null,
            truncated: false,
            messages: [
              { itemId: 'm1', role: 'user', text: 'Retry failed webhooks with backoff.', at: 0 },
              { itemId: 'm2', role: 'assistant', text: 'Done. Tests pass.', at: 0 }
            ]
          }
        ]
      }
    })),
  render: () => <CloudWorkspacesHome />,
  interact: openAsleepRow
})

/** The snapshot predates this computer's reader key. */
export const asleepNotSealedForKey = defineFixture({
  width: WIDTH,
  store: { orcaProfileAuthStatus: AUTH_STATUS },
  setup: () => stubAsleep(async () => ({ state: 'not_sealed_for_key' })),
  render: () => <CloudWorkspacesHome />,
  interact: openAsleepRow
})

/** Builds with Orca Cloud routines get a Routines entry next to the list they fill. */
export const withRoutinesEntry = defineFixture({
  width: WIDTH,
  store: { orcaProfileAuthStatus: AUTH_STATUS },
  setup: () => {
    const rows = teamWorkspaces()
    stubCloudWorkspacesApi(() => Promise.resolve({ ok: true, value: rows }))
    Object.assign(window.api, {
      cloudApi: {
        availability: async () => ({ status: 'ready', controlPlaneUrl: 'https://api.orca.dev' })
      }
    })
  },
  render: () => <CloudWorkspacesHome />,
  interact: () =>
    waitFor(
      () =>
        document.querySelector('[data-cloud-workspace-row]') !== null &&
        [...document.querySelectorAll('button')].some((b) => b.textContent === 'Routines')
    )
})
