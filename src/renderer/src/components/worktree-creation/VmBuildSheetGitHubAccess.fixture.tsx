// CREATE-GH-STEP: the wizard's GitHub access step in each of its states, on a GitHub-only Orca Cloud
// create (the same sheet an owned create uses).
import { defineFixture } from '../../component-fixtures/component-fixture'
import type { PendingWorktreeCreation } from '@/lib/workspace/creation/pending-worktree-creation'
import type { CloudCreateGitHubAccess } from '@/lib/orca-cloud/cloud-create-github-access'
import { setCloudCreateGitHubAccessForTest } from '@/lib/orca-cloud/cloud-create-github-access-registry'
import { githubCreateRequest } from '@/lib/orca-cloud/start-cloud-workspace-from-github'
import { sheet, stampsFor, stubBillingRole, T0 } from './vm-build-sheet-fixture-support'

const REQUEST = githubCreateRequest({
  repoUrl: 'https://github.com/acme/web',
  fullName: 'acme/web',
  name: 'Fix the login redirect',
  agent: 'claude',
  composerRepoId: 'repo'
})

const STARTING = ['[orca-cloud] provisioning', '[orca-cloud] plan-clone']
const CLONED = [
  ...STARTING,
  '[orca-cloud] cloning',
  '[orca-cloud] clone-progress 100 checkout',
  '[orca-cloud] connecting'
]

function build(lines: readonly string[]): PendingWorktreeCreation {
  return {
    creationId: 'fixture',
    phase: 'provisioning-vm',
    status: 'creating',
    startedAt: T0,
    indeterminate: false,
    loaderVisible: true,
    provisioningLog: lines.join('\n'),
    provisioningLogStamps: stampsFor(lines.length),
    phaseLog: [{ phase: 'provisioning-vm', at: T0 }],
    request: REQUEST
  }
}

const BASE: CloudCreateGitHubAccess = {
  repoUrl: 'https://github.com/acme/web',
  repoName: 'acme/web',
  owner: 'acme',
  phase: 'checking',
  opened: false,
  remembered: false,
  holding: false
}

function fixture(
  access: Partial<CloudCreateGitHubAccess>,
  lines: readonly string[] = STARTING,
  now = T0 + 2_500
) {
  return defineFixture({
    width: 760,
    setup: () => {
      stubBillingRole(true)
      setCloudCreateGitHubAccessForTest('fixture', { ...BASE, ...access })
    },
    render: () => sheet(build(lines), null, now)
  })
}

export const checking = fixture({ phase: 'checking' })
export const ok = fixture({ phase: 'ok' })
export const install = fixture({ phase: 'needed', ask: 'install' })
export const installWaiting = fixture({ phase: 'needed', ask: 'install', opened: true })
export const installHolding = fixture(
  { phase: 'needed', ask: 'install', opened: true, holding: true },
  CLONED,
  T0 + 9_000
)
export const configure = fixture({ phase: 'needed', ask: 'configure' })
export const ownerOnly = fixture({ phase: 'needed', ask: 'request' })
export const requested = fixture({ phase: 'needed', ask: 'requested' })
export const granted = fixture({ phase: 'granted', ask: 'install' }, CLONED, T0 + 9_000)
export const skipped = fixture({ phase: 'skipped', ask: 'install' })
export const skippedEarlier = fixture({ phase: 'skipped', ask: 'install', remembered: true })
