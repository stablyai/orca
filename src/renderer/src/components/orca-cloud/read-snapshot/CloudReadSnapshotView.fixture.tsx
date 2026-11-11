import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { ReadSnapshot } from '../../../../../shared/cloud-workspaces/read-snapshot'
import {
  CloudReadSnapshotView,
  type CloudReadViewState,
  type CloudReadWake
} from './CloudReadSnapshotView'

const NOW = 1_794_230_000_000
const MIN = 60_000

const snapshot: ReadSnapshot = {
  v: 1,
  workspaceId: 'sbx_00000000000000000000beef',
  snapshotId: 'snap_1',
  capturedAt: NOW - 42 * MIN,
  reason: 'sleep',
  pr: {
    number: 412,
    title: 'Retry checkout webhooks with backoff',
    state: 'open',
    url: 'https://github.com/acme/web/pull/412',
    checksStatus: 'failure',
    checksSummary: '1 of 9 failed'
  },
  git: {
    branch: 'checkout-retries',
    head: '3f95655684912ab',
    changeCount: 3,
    added: 131,
    removed: 22,
    changes: [
      {
        path: 'src/payments/webhooks.ts',
        status: 'modified',
        area: 'unstaged',
        added: 88,
        removed: 19
      },
      {
        path: 'src/payments/backoff.ts',
        status: 'added',
        area: 'untracked',
        added: 41,
        removed: 0
      },
      { path: 'README.md', status: 'modified', area: 'staged', added: 2, removed: 3 }
    ],
    commits: [
      {
        id: '3f956556849',
        subject: 'Back off webhook retries',
        author: 'Grace',
        at: NOW - 70 * MIN
      },
      {
        id: '41b60ea4b10',
        subject: 'Log webhook failures',
        author: 'Grace',
        at: NOW - 3 * 60 * MIN
      }
    ]
  },
  sessions: [
    {
      sessionId: 's1',
      agent: 'claude',
      title: 'Retry failed checkout webhooks',
      status: 'attention',
      turnOutcome: null,
      updatedAt: NOW - 43 * MIN,
      truncated: true,
      messages: [
        {
          itemId: 'm1',
          role: 'user',
          text: 'Retry failed checkout webhooks with exponential backoff.',
          at: NOW - 80 * MIN
        },
        {
          itemId: 'm2',
          role: 'assistant',
          text: 'Added a backoff helper and wired it into the webhook handler.',
          at: NOW - 60 * MIN
        },
        { itemId: 'm3', role: 'user', text: 'Cap it at 5 attempts.', at: NOW - 50 * MIN },
        {
          itemId: 'm4',
          role: 'assistant',
          text: 'Capped at 5 attempts. One e2e check fails on a timeout unrelated to this change. Should I re-run it or skip it for now?',
          at: NOW - 43 * MIN
        }
      ]
    },
    {
      sessionId: 's2',
      agent: 'codex',
      title: 'Write tests for backoff',
      status: 'idle',
      turnOutcome: 'done',
      updatedAt: NOW - 45 * MIN,
      truncated: false,
      messages: [
        {
          itemId: 'n1',
          role: 'user',
          text: 'Write unit tests for the backoff helper.',
          at: NOW - 55 * MIN
        },
        { itemId: 'n2', role: 'assistant', text: 'Added 6 tests. All pass.', at: NOW - 45 * MIN }
      ]
    }
  ]
}

const noop = (): void => {}

function view(
  state: CloudReadViewState,
  extra: { wake?: CloudReadWake; retrying?: boolean; linux?: boolean } = {}
) {
  return (
    <div className="bg-background p-6">
      <CloudReadSnapshotView
        title="Checkout retries"
        state={state}
        now={NOW}
        onWake={noop}
        wake={extra.wake ?? null}
        onRetry={noop}
        retrying={extra.retrying ?? false}
        linux={extra.linux ?? false}
      />
    </div>
  )
}

const WIDTH = 620

/** Two agents (one needs input, one done), PR with failing checks, changes with +/−. */
export const ready = defineFixture({
  width: WIDTH,
  render: () => view({ kind: 'ready', snapshot })
})

/** "Show earlier messages" opened on the first chat. */
export const readyExpanded = defineFixture({
  width: WIDTH,
  render: () => view({ kind: 'ready', snapshot }),
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('[aria-expanded="false"]')?.click()
  }
})

/** A saved copy with no PR, agents or source control state. */
export const readyBare = defineFixture({
  width: WIDTH,
  render: () =>
    view({ kind: 'ready', snapshot: { ...snapshot, pr: null, git: null, sessions: [] } })
})

export const loading = defineFixture({ width: WIDTH, render: () => view({ kind: 'loading' }) })

export const empty = defineFixture({ width: WIDTH, render: () => view({ kind: 'no_snapshot' }) })

export const notSealedForKey = defineFixture({
  width: WIDTH,
  render: () => view({ kind: 'not_sealed_for_key' })
})

export const notFound = defineFixture({ width: WIDTH, render: () => view({ kind: 'not_found' }) })

export const keychainUnavailable = defineFixture({
  width: WIDTH,
  render: () => view({ kind: 'unavailable', message: 'no keychain' })
})

export const error = defineFixture({
  width: WIDTH,
  render: () => view({ kind: 'error', message: "Couldn't reach Orca Cloud. Your files are safe." })
})

/** Keychain missing on Linux: also names the keyring to set up. */
export const keychainUnavailableLinux = defineFixture({
  width: WIDTH,
  render: () => view({ kind: 'unavailable', message: 'no keychain' }, { linux: true })
})

/** "Wake to continue" pressed 3 s ago: Waking dot, elapsed time on the busy button. */
export const waking3s = defineFixture({
  width: WIDTH,
  render: () =>
    view({ kind: 'ready', snapshot }, { wake: { phase: 'waking', startedAt: Date.now() - 3_000 } })
})

/** Past 10 s: the "Taking longer than usual" line under the header. */
export const waking12s = defineFixture({
  width: WIDTH,
  render: () =>
    view({ kind: 'ready', snapshot }, { wake: { phase: 'waking', startedAt: Date.now() - 12_000 } })
})

/** The wake failed: shared "Couldn't wake" copy with Try again; the copy stays readable. */
export const wakeFailed = defineFixture({
  width: WIDTH,
  render: () => view({ kind: 'ready', snapshot }, { wake: { phase: 'failed' } })
})

/** A rollback was refused. */
export const stale = defineFixture({ width: WIDTH, render: () => view({ kind: 'stale' }) })

/** The copy was not signed by this workspace's VM (forged, re-signed, or unsigned after a pin). */
export const unverified = defineFixture({
  width: WIDTH,
  render: () => view({ kind: 'unverified' })
})

/** The wake failed on the server for no known reason: the shared "Couldn't wake the sandbox" copy. */
export const wakeFailedServerError = defineFixture({
  width: WIDTH,
  render: () =>
    view({ kind: 'ready', snapshot }, { wake: { phase: 'failed', unknownServerError: true } })
})

/** Signed by a different key than before: not shown; the only way on is "Wake to continue". */
export const signerChanged = defineFixture({
  width: WIDTH,
  render: () => view({ kind: 'signer_changed' })
})
