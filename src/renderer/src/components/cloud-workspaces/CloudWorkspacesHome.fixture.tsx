import { defineFixture } from '../../component-fixtures/component-fixture'
import { CloudWorkspacesHome } from './CloudWorkspacesHome'
import {
  AUTH_STATUS,
  stubCloudWorkspacesApi,
  teamWorkspaces,
  workspace
} from './cloud-workspaces.test-fixture'
import type { CloudReadSnapshotState } from '../../../../shared/cloud-workspaces/read-snapshot-state'
import type { CloudWorkspacePrefsDocument } from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import { setPrefsAccount } from './cloud-workspace-prefs'
import { getOrcaAccountKey } from '@/hooks/use-orca-account-key'
import { writeHomeSwitches } from './cloud-workspaces-home-prefs'

const FIXTURE_ACCOUNT = getOrcaAccountKey(AUTH_STATUS)

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

/** Synced prefs: two pins on top (pin order), Payments collapsed, rows in their manual order. */
export const pinnedAndArranged = defineFixture({
  width: WIDTH,
  store: { orcaProfileAuthStatus: AUTH_STATUS },
  setup: () => {
    const rows = teamWorkspaces()
    stubCloudWorkspacesApi(() => Promise.resolve({ ok: true, value: rows }))
    const document: CloudWorkspacePrefsDocument = {
      pinned: [rows[3]!.id, rows[0]!.id],
      order: [rows[2]!.id],
      sections: ['Payments'],
      collapsed: []
    }
    Object.assign(window.api.cloudWorkspaces, {
      getPrefs: () =>
        Promise.resolve({ ok: true as const, value: { document, revision: 3, updatedAt: 1 } }),
      putPrefs: (next: CloudWorkspacePrefsDocument) =>
        Promise.resolve({
          ok: true as const,
          value: { document: next, revision: 4, updatedAt: 2 }
        })
    })
    setPrefsAccount(`fixture:${Math.random()}`)
  },
  render: () => <CloudWorkspacesHome />,
  interact: () =>
    waitFor(() => document.querySelector('[data-cloud-workspace-group="pinned"]') !== null)
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

/** Routine runs stay off Home; the Routine runs switch brings in-flight ones back, marked. */
function stubWithRoutineRuns(): void {
  writeHomeSwitches(FIXTURE_ACCOUNT, { running: false, archived: false, routines: false })
  const rows = teamWorkspaces()
  const run = workspace({
    id: 'sbx_0000000000000000000000e1',
    title: 'nightly-deps · run',
    status: 'running',
    fromRoutine: true,
    routineName: 'nightly-deps',
    section: null
  })
  stubCloudWorkspacesApi(() => Promise.resolve({ ok: true, value: rows }))
  Object.assign(window.api.cloudWorkspaces, {
    list: (query: { routines?: string }) =>
      Promise.resolve(
        query.routines === 'include'
          ? {
              ok: true as const,
              value: [run, ...rows],
              routineRuns: { routines: 2, hidden: 0, hiddenRunning: 0, hiddenComputeMs: 0 }
            }
          : {
              ok: true as const,
              value: rows,
              routineRuns: {
                routines: 2,
                hidden: 1,
                hiddenRunning: 1,
                hiddenComputeMs: run.cost.computeMs
              }
            }
      )
  })
}

function routineSwitch(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[aria-label="Show routine runs"]')
}

/** A team without routines never sees the switch. */
export const noRoutines = defineFixture({
  width: WIDTH,
  store: { orcaProfileAuthStatus: AUTH_STATUS },
  setup: () => {
    const rows = teamWorkspaces()
    stubCloudWorkspacesApi(() =>
      Promise.resolve({
        ok: true,
        value: rows,
        routineRuns: { routines: 0, hidden: 0, hiddenRunning: 0, hiddenComputeMs: 0 }
      })
    )
  },
  render: () => <CloudWorkspacesHome />,
  interact: () => waitFor(() => document.querySelector('[data-cloud-workspace-row]') !== null)
})

/** Default: routine runs are hidden; the switch says how many are running. */
export const routineRunsHidden = defineFixture({
  width: WIDTH,
  store: { orcaProfileAuthStatus: AUTH_STATUS },
  setup: stubWithRoutineRuns,
  render: () => <CloudWorkspacesHome />,
  interact: () =>
    waitFor(
      () =>
        document.querySelector('[data-cloud-workspace-row]') !== null && routineSwitch() !== null
    )
})

/** Switch on: the in-flight run is listed with the routine mark. */
export const routineRunsShown = defineFixture({
  width: WIDTH,
  store: { orcaProfileAuthStatus: AUTH_STATUS },
  setup: stubWithRoutineRuns,
  render: () => <CloudWorkspacesHome />,
  interact: async () => {
    await waitFor(
      () =>
        document.querySelector('[data-cloud-workspace-row]') !== null && routineSwitch() !== null
    )
    routineSwitch()!.click()
    await waitFor(() => document.querySelector('[aria-label="Routine run"]') !== null)
  }
})

/** JA-30: a few workspaces (under 5) and no filter on: title and count only, no filter row. */
export const fewWorkspaces = defineFixture({
  width: WIDTH,
  store: { orcaProfileAuthStatus: AUTH_STATUS },
  setup: () => {
    const rows = teamWorkspaces().slice(0, 3)
    stubCloudWorkspacesApi(() => Promise.resolve({ ok: true, value: rows }))
  },
  render: () => <CloudWorkspacesHome />,
  interact: () => waitFor(() => document.querySelector('[data-cloud-workspace-row]') !== null)
})

/** JA-30: Mine on a team where others have workspaces: "You don't have any…", same button. */
export const emptyMine = defineFixture({
  width: WIDTH,
  store: { orcaProfileAuthStatus: AUTH_STATUS },
  setup: () => {
    const rows = teamWorkspaces()
    stubCloudWorkspacesApi(() => Promise.resolve({ ok: true, value: rows }))
    Object.assign(window.api.cloudWorkspaces, {
      list: (query: { scope?: string }) =>
        Promise.resolve({ ok: true as const, value: query.scope === 'mine' ? [] : rows })
    })
  },
  render: () => <CloudWorkspacesHome />,
  interact: async () => {
    await waitFor(() => document.querySelector('[data-cloud-workspace-row]') !== null)
    const mine = [...document.querySelectorAll<HTMLElement>('[role="radio"], button')].find(
      (el) => el.textContent?.trim() === 'Mine'
    )
    mine?.click()
    await waitFor(() => (document.querySelector('section')?.textContent ?? '').includes('yet.'))
  }
})
