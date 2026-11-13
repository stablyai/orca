// "Open cloud workspace…" (replaces the Home list): a teammate's shared workspace, one started on
// another computer, the empty and error states, and the focused lists other surfaces open it with.
import { defineFixture } from '../../component-fixtures/component-fixture'
import { CloudWorkspacePickerDialog } from './CloudWorkspacePicker'
import {
  closeCloudWorkspacePicker,
  openCloudWorkspacePicker,
  type CloudWorkspacePickerFocus
} from './cloud-workspace-picker-store'
import {
  AUTH_STATUS,
  FIXTURE_NOW,
  presence,
  stubCloudWorkspacesApi,
  workspace
} from './cloud-workspaces.test-fixture'
import type { CloudWorkspace } from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'

const WIDTH = 820

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 3000
  while (!check() && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

function rows(): CloudWorkspace[] {
  return [
    workspace({
      title: 'Refund webhooks',
      repo: { url: 'https://github.com/acme/payments.git', branch: 'refund-webhooks' },
      ownerUserId: 'user_grace',
      createdBy: 'user_grace',
      access: 'can_open',
      presence: [presence('user_grace', 'typing')]
    }),
    workspace({
      title: 'Ledger migration',
      ownerUserId: 'user_linus',
      createdBy: 'user_linus',
      access: 'can_open',
      status: 'suspended',
      lastActivityAt: FIXTURE_NOW - 3 * 3_600_000
    }),
    workspace({
      // Yours, started on your laptop: this computer has no row for it yet.
      title: 'Docs search',
      repo: { url: 'https://github.com/acme/docs.git', branch: 'search' },
      status: 'suspended',
      lastActivityAt: FIXTURE_NOW - 26 * 3_600_000
    })
  ]
}

function picker(
  focus: CloudWorkspacePickerFocus,
  list: () => ReturnType<Parameters<typeof stubCloudWorkspacesApi>[0]>,
  ready: string
) {
  return defineFixture({
    width: WIDTH,
    store: { orcaProfileAuthStatus: AUTH_STATUS },
    setup: () => {
      stubCloudWorkspacesApi(list)
      closeCloudWorkspacePicker()
      openCloudWorkspacePicker(focus)
    },
    render: () => (
      <div className="h-[640px]">
        <CloudWorkspacePickerDialog />
      </div>
    ),
    interact: () => waitFor(() => document.querySelector(ready) !== null)
  })
}

/** From the Add project menu or the palette: a teammate's shared one, and one from another computer. */
export const sharedByTeammate = picker(
  { kind: 'open' },
  () => Promise.resolve({ ok: true, value: rows() }),
  '[data-cloud-workspace-row]'
)

/** Nothing to open yet: start one. */
export const empty = picker(
  { kind: 'open' },
  () => Promise.resolve({ ok: true, value: [] }),
  '[data-cloud-workspace-picker] p'
)

/** The list could not be read: InlineError with Try again. */
export const error = picker(
  { kind: 'open' },
  () => Promise.resolve({ ok: false, error: 'unavailable' }),
  '[data-slot="inline-error"]'
)

/** A teammate's profile, "Show all": their workspaces. */
export const teammate = picker(
  { kind: 'teammate', userId: 'user_grace' },
  () => Promise.resolve({ ok: true, value: rows() }),
  '[data-cloud-workspace-row]'
)

/** At the running-sandbox limit: your running ones, to put one to sleep. */
export const runningLimit = picker(
  { kind: 'running' },
  () =>
    Promise.resolve({
      ok: true,
      value: [workspace({ title: 'Checkout retries' }), workspace({ title: 'Flaky e2e repro' })]
    }),
  '[data-cloud-workspace-row]'
)
