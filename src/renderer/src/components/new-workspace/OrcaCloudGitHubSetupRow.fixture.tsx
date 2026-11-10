import { defineFixture } from '../../component-fixtures/component-fixture'
import { orcaCloudGitHubSetupRow } from '@/lib/orca-cloud/orca-cloud-github-setup-row'
import { OrcaCloudGitHubSetupRow } from './OrcaCloudGitHubSetupRow'

// The setup panel's GitHub row in each cloud-start state (D1–D3), until w2-lifecycle's panel
// shell renders it in place.

const base = { repoName: 'acme/billing', owner: 'acme', loading: false }

function row(access: Parameters<typeof orcaCloudGitHubSetupRow>[0]) {
  return defineFixture({
    width: 620,
    render: () => <OrcaCloudGitHubSetupRow row={orcaCloudGitHubSetupRow(access)} />
  })
}

export const D1Needed = row({ ...base, state: 'needs-install', access: 'missing' })
export const D2Requested = row({ ...base, state: 'pending-approval', access: 'requested' })
export const D3NotOnGitHub = row({ repoName: 'scratch', loading: false, state: 'not-github' })
export const Granted = row({ ...base, state: 'ok', access: 'granted' })
export const Public = row({ ...base, state: 'ok', access: 'public' })
export const Checking = row({ ...base, state: 'unknown', loading: true })
