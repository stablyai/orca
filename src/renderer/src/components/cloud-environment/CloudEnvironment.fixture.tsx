import { InlineError } from '@/components/ui/inline-error'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { BuildHistoryList } from './BuildHistoryList'
import { BuildLogViewer } from './BuildLogViewer'
import {
  buildingLog,
  failedLog,
  FIXTURE_NOW,
  longLog,
  sampleBuild,
  sampleEnvironment,
  sampleHistory,
  sampleStaleness,
  succeededLog
} from './cloud-environment-fixture-data'
import { stalenessBannerCopy } from './cloud-environment-copy'
import {
  CloudEnvironmentEmptyState,
  CloudEnvironmentSkeleton,
  CloudEnvironmentPanel
} from './CloudEnvironmentPanel'
import { draftFromEnvironment, emptyDraft } from './environment-draft'
import { EnvironmentForm, EnvironmentSummary } from './EnvironmentForm'
import type { LocalRepoSuggestion } from './EnvironmentFormFields'
import { StalenessBanner } from './StalenessBanner'

const noop = (): void => {}

const suggestions: LocalRepoSuggestion[] = [
  { repoId: 'r1', slug: 'acme/web', path: '/src/web', displayName: 'web' },
  { repoId: 'r2', slug: 'acme/api', path: '/src/api', displayName: 'api' },
  {
    repoId: 'r3',
    slug: 'acme/design-system',
    path: '/src/ds',
    displayName: 'design-system'
  }
]

const formHandlers = {
  saving: false,
  error: null,
  conflict: false,
  suggestions,
  importProjects: suggestions,
  onReadImports: async () => ({
    ok: true as const,
    data: {
      envVarNames: ['NPM_TOKEN', 'STRIPE_KEY'],
      installScript: 'pnpm install',
      sources: ['Conductor']
    }
  }),
  onSave: noop
}

export const emptyState = defineFixture({
  width: 640,
  render: () => <CloudEnvironmentEmptyState canAdmin onStart={noop} />
})

export const emptyStateMember = defineFixture({
  width: 640,
  render: () => <CloudEnvironmentEmptyState canAdmin={false} onStart={noop} />
})

export const loading = defineFixture({
  width: 680,
  render: () => <CloudEnvironmentSkeleton />
})

export const networkError = defineFixture({
  width: 640,
  render: () => (
    <InlineError
      title="Couldn’t load the cloud environment"
      detail="Could not reach Orca Cloud. Try again in a moment."
      retryLabel="Try again"
      onRetry={noop}
    />
  )
})

export const createForm = defineFixture({
  width: 680,
  render: () => (
    <EnvironmentForm
      mode="create"
      base={emptyDraft(['acme/web'])}
      {...formHandlers}
      onCancel={noop}
    />
  )
})

export const formAdminUnsaved = defineFixture({
  width: 680,
  render: () => {
    const base = draftFromEnvironment(sampleEnvironment)
    return (
      <EnvironmentForm
        mode="edit"
        base={base}
        initialDraft={{
          ...base,
          machineSize: 'large',
          envVarNames: [...base.envVarNames, 'REDIS_URL']
        }}
        {...formHandlers}
      />
    )
  }
})

export const formAdminConflict = defineFixture({
  width: 680,
  render: () => {
    const base = draftFromEnvironment(sampleEnvironment)
    return (
      <EnvironmentForm
        mode="edit"
        base={base}
        initialDraft={{
          ...base,
          installScript: `${base.installScript}\npnpm build`
        }}
        {...formHandlers}
        conflict
        conflictEditor="Priya Shah"
        onReload={noop}
      />
    )
  }
})

export const formMemberReadOnly = defineFixture({
  width: 680,
  render: () => <EnvironmentSummary base={draftFromEnvironment(sampleEnvironment)} />
})

export const buildHistory = defineFixture({
  width: 680,
  render: () => (
    <BuildHistoryList
      builds={sampleHistory}
      selectedBuildId="bld_000000000007"
      canAdmin
      busyBuildId={null}
      now={FIXTURE_NOW}
      onSelect={noop}
      onCancel={noop}
      onActivate={noop}
    />
  )
})

export const buildHistoryMember = defineFixture({
  width: 680,
  render: () => (
    <BuildHistoryList
      builds={sampleHistory}
      selectedBuildId={null}
      canAdmin={false}
      busyBuildId={null}
      now={FIXTURE_NOW}
      onSelect={noop}
      onCancel={noop}
      onActivate={noop}
    />
  )
})

const runningBuild = sampleHistory[0]
export const logBuilding = defineFixture({
  width: 760,
  render: () => (
    <BuildLogViewer
      build={runningBuild}
      buffer={buildingLog(runningBuild)}
      activeBuildNumber={6}
      streamState="live"
      now={FIXTURE_NOW}
    />
  )
})

const okBuild = sampleBuild({
  number: 6,
  active: true,
  createdAt: FIXTURE_NOW - 26 * 60_000
})
export const logSucceeded = defineFixture({
  width: 760,
  render: () => (
    <BuildLogViewer
      build={okBuild}
      buffer={succeededLog(okBuild)}
      activeBuildNumber={6}
      streamState="ended"
      now={FIXTURE_NOW}
    />
  )
})

const failedBuild = sampleHistory[1]
export const logFailed = defineFixture({
  width: 760,
  render: () => (
    <BuildLogViewer
      build={failedBuild}
      buffer={failedLog(failedBuild)}
      activeBuildNumber={6}
      streamState="ended"
      now={FIXTURE_NOW}
    />
  )
})

const longBuild = sampleBuild({
  number: 9,
  createdAt: FIXTURE_NOW - 6 * 60_000,
  snapshotStartedAt: FIXTURE_NOW - 6 * 60_000 + 240_000,
  finishedAt: FIXTURE_NOW - 6 * 60_000 + 270_000,
  durationMs: 270_000,
  logBytes: 2_000_000,
  logTruncated: true
})
export const logLong = defineFixture({
  width: 760,
  render: () => (
    <BuildLogViewer
      build={longBuild}
      buffer={longLog(longBuild)}
      activeBuildNumber={6}
      streamState="ended"
      now={FIXTURE_NOW}
    />
  )
})

export const logReconnecting = defineFixture({
  width: 760,
  render: () => (
    <BuildLogViewer
      build={runningBuild}
      buffer={buildingLog(runningBuild)}
      activeBuildNumber={6}
      streamState="reconnecting"
      now={FIXTURE_NOW}
    />
  )
})

export const logStreamError = defineFixture({
  width: 760,
  render: () => (
    <BuildLogViewer
      build={runningBuild}
      buffer={buildingLog(runningBuild)}
      activeBuildNumber={6}
      streamState="error"
      streamError="The live log disconnected."
      onRetryStream={noop}
      now={FIXTURE_NOW}
    />
  )
})

export const stalenessBanners = defineFixture({
  width: 680,
  render: () => (
    <div className="space-y-3">
      {[sampleStaleness.deps, sampleStaleness.config, sampleStaleness.branch].map((staleness) => {
        const copy = stalenessBannerCopy(staleness, 6)
        return copy ? (
          <StalenessBanner
            key={staleness.recommendation}
            copy={copy}
            canAdmin
            building={false}
            onRebuild={noop}
          />
        ) : null
      })}
    </div>
  )
})

export const panelOverviewFailed = defineFixture({
  width: 760,
  render: () => {
    const builds = sampleHistory.slice(1)
    return (
      <CloudEnvironmentPanel
        environment={sampleEnvironment}
        builds={builds}
        canAdmin
        now={FIXTURE_NOW}
        frozenNow={FIXTURE_NOW}
        selectedBuild={builds[0]}
        log={{
          buffer: failedLog(builds[0]),
          state: 'ended',
          error: null,
          onRetry: noop
        }}
        staleness={stalenessBannerCopy(sampleStaleness.deps, 6)}
        starting={false}
        busyBuildId={null}
        actionError={null}
        agentAvailable
        agentLaunching={false}
        form={formHandlers}
        onBuild={noop}
        onCancel={noop}
        onActivate={noop}
        onSelectBuild={noop}
        onConfigureWithAgent={noop}
      />
    )
  }
})

export const panelMember = defineFixture({
  width: 760,
  render: () => {
    const builds = sampleHistory.slice(2)
    return (
      <CloudEnvironmentPanel
        environment={sampleEnvironment}
        builds={builds}
        canAdmin={false}
        now={FIXTURE_NOW}
        frozenNow={FIXTURE_NOW}
        selectedBuild={okBuild}
        log={{
          buffer: succeededLog(okBuild),
          state: 'ended',
          error: null,
          onRetry: noop
        }}
        staleness={stalenessBannerCopy(sampleStaleness.branch, 6)}
        starting={false}
        busyBuildId={null}
        actionError={null}
        agentAvailable={false}
        agentLaunching={false}
        form={formHandlers}
        onBuild={noop}
        onCancel={noop}
        onActivate={noop}
        onSelectBuild={noop}
        onConfigureWithAgent={noop}
      />
    )
  }
})
