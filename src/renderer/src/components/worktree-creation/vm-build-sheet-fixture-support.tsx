// Shared builders for the VM build sheet fixtures.
import React from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import type { PendingWorktreeCreation } from '@/lib/workspace/creation/pending-worktree-creation'
import { VmBuildSheet } from './VmBuildSheet'
import { formatElapsedTime } from './worktree-creation-clock'
import type { VmBuildStepTimings } from './vm-build-timing'
import { useAppStore } from '@/store'
import type { Repo } from '../../../../shared/repo-types'

export const LOG_LINES = [
  'Creating sandbox from snapshot snap_7f2c…',
  'Sandbox ready: sbx_41d9 (us-east-1)',
  'Cloning repository…',
  'Starting orca serve on :7420',
  'Pairing code emitted.'
]
export const LOG = LOG_LINES.join('\n')
// Every fixture is drawn 102 seconds into its build, with lines arriving a second or so apart.
export const T0 = 1_700_000_000_000
export const NOW = T0 + 102_000
export const stampsFor = (lines: number): number[] =>
  Array.from({ length: lines }, (_, index) => T0 + 400 + index * 1300)

export type Recipe = NonNullable<PendingWorktreeCreation['request']['ephemeralVmRecipe']>
export const LOCAL_RECIPE: Recipe = { sourceRepoId: 'repo', recipeId: 'sandbox', projectId: 'p' }
export const CLOUD_RECIPE: Recipe = { ...LOCAL_RECIPE, recipeId: 'cloud', provider: 'orca-cloud' }

export function entry(
  patch: Partial<PendingWorktreeCreation>,
  recipe: Recipe = LOCAL_RECIPE
): PendingWorktreeCreation {
  const log = patch.provisioningLog ?? LOG
  return {
    creationId: 'fixture',
    phase: 'provisioning-vm',
    status: 'creating',
    startedAt: T0,
    indeterminate: false,
    loaderVisible: true,
    provisioningLog: log,
    provisioningLogStamps: stampsFor(log === '' ? 0 : log.split('\n').length),
    phaseLog: [{ phase: 'provisioning-vm', at: T0 }],
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sheet reads only name and ephemeralVmRecipe from the request.
    request: { name: 'fix-login', ephemeralVmRecipe: recipe } as PendingWorktreeCreation['request'],
    ...patch
  }
}

export function sheet(
  value: PendingWorktreeCreation,
  error: string | null,
  now: number,
  agentSignInRow?: React.ReactNode
) {
  return (
    <div className="bg-background p-3">
      <VmBuildSheet
        creationId="fixture"
        entry={value}
        now={now}
        elapsedLabel={formatElapsedTime(now - value.startedAt)}
        error={error}
        onCancel={() => {}}
        onRetry={() => {}}
        onDismiss={() => {}}
        onEditRecipe={() => {}}
        agentSignInRow={agentSignInRow}
        stepTimings={FIXTURE_STEP_TIMINGS}
        cloudAgentStep={null}
      />
    </div>
  )
}

// What the dev control plane measured (GET /v1/config): starts p50 2.9 s, p95 4.0 s.
const FIXTURE_STEP_TIMINGS: VmBuildStepTimings = { provision: { p50Ms: 2_900, p95Ms: 4_000 } }

/** The repository a cloud card names: a GitHub remote reads as owner/name. */
export function seedFixtureRepo(remoteUrl: string | null = 'git@github.com:acme/web.git'): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sheet reads only id, displayName and gitRemoteIdentity.
  const repo = {
    id: 'repo',
    displayName: 'web',
    gitRemoteIdentity: remoteUrl ? { remoteUrl } : null
  } as unknown as Repo
  useAppStore.setState({ repos: [repo] })
}

export function frame(
  value: PendingWorktreeCreation,
  error: string | null = null,
  now = NOW,
  agentSignInRow?: React.ReactNode
) {
  return defineFixture({
    width: 760,
    setup: () => seedFixtureRepo(),
    render: () => sheet(value, error, now, agentSignInRow)
  })
}

export const CLOUD_LOG = '[orca-cloud] checking-entitlement\n[orca-cloud] provisioning'
// What the provider really prints around a failure: progress, internals the plain view hides, and the cause.
export const CLOUD_FAILED_LOG = [
  '[orca-cloud] checking-entitlement',
  '[orca-cloud] provisioning',
  'sandbox sbx_41d9 scheduled on pool p-use1-3',
  'Orca Cloud refused the request (provider_unavailable).'
].join('\n')
export const FAILED_LOG = `${LOG}\nError: snapshot snap_7f2c not found`
