import { defineFixture } from '../../component-fixtures/component-fixture'
import {
  recordCloudSecretsMissing,
  resetCloudSecretsMissingForTests
} from '@/lib/orca-cloud/cloud-secrets-missing-notice-store'
import type { HostedWorkspaceStatus } from '../../../../shared/hosted-sandbox/hosted-sandbox-wire'
import { CloudWorkspaceStatusPanel } from '../orca-cloud/CloudWorkspaceStatusPanel'

const NOW = Date.now()
const noop = (): void => {}
const ACTIONS = { onWake: noop, onRestart: noop, onArchive: noop, onUnarchive: noop }
const RUNNING: HostedWorkspaceStatus = {
  state: 'ready',
  metrics: {
    cpuPercent: 37,
    cpus: 4,
    load1: 1.2,
    memTotalBytes: 8e9,
    memUsedBytes: 5.1e9,
    diskTotalBytes: 34.3e9,
    diskUsedBytes: 6.2e9,
    uptimeSeconds: 7_420,
    oomKills: 0,
    lastOomVictim: null,
    orcadAlive: true
  },
  uptimeMs: 2 * 3_600_000,
  usage: { totalMs: 14.6 * 3_600_000, centsPerHour: 100, costCents: 1460 },
  archive: null,
  checkedAt: NOW
}

/** The workspace's cloud panel after the build sheet's Secrets row was skipped. */
export const panelSecretsMissing = defineFixture({
  width: 300,
  setup: () => {
    resetCloudSecretsMissingForTests()
    recordCloudSecretsMissing('ws-secrets', {
      names: ['STRIPE_TEST_KEY', 'SENTRY_DSN'],
      repoKey: 'github.com/acme/web'
    })
  },
  render: () => (
    <div className="rounded-md border border-border bg-floating-surface p-3">
      <CloudWorkspaceStatusPanel
        workspaceId="ws-secrets"
        state="running"
        entry={{ status: RUNNING, loading: false, error: null, fetchedAt: NOW - 42_000 }}
        pending={undefined}
        actions={ACTIONS}
      />
    </div>
  )
})
