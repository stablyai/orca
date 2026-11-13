// AUTO-ENV-DEPS-LABEL: an automatic environment's lockfile install, on the active build's header.
import { defineFixture } from '../../component-fixtures/component-fixture'
import {
  FIXTURE_NOW,
  sampleEnvironment,
  sampleHistory,
  succeededLog
} from './cloud-environment-fixture-data'
import { CloudEnvironmentPanel } from './CloudEnvironmentPanel'

const noop = (): void => {}

function panel(outcome: 'installed' | 'skipped') {
  const builds = sampleHistory
    .slice(2)
    .map((build) =>
      build.active ? { ...build, autoInstall: { manager: 'pnpm' as const, outcome } } : build
    )
  const active = builds.find((build) => build.active) ?? builds[0]
  return defineFixture({
    width: 760,
    render: () => (
      <CloudEnvironmentPanel
        environment={sampleEnvironment}
        builds={builds}
        canAdmin={false}
        now={FIXTURE_NOW}
        frozenNow={FIXTURE_NOW}
        selectedBuild={active}
        log={{ buffer: succeededLog(active), state: 'ended', error: null, onRetry: noop }}
        staleness={null}
        starting={false}
        busyBuildId={null}
        actionError={null}
        agentAvailable={false}
        agentLaunching={false}
        form={{
          saving: false,
          error: null,
          conflict: false,
          suggestions: [],
          importProjects: [],
          onReadImports: async () => ({
            ok: true as const,
            data: { envVarNames: [], sources: [] }
          }),
          onSave: noop
        }}
        onBuild={noop}
        onCancel={noop}
        onActivate={noop}
        onSelectBuild={noop}
        onConfigureWithAgent={noop}
        onFixWithAgent={null}
        onGiveAccess={null}
      />
    )
  })
}

/** Dependencies installed from the lockfile. */
export const autoInstalled = panel('installed')
/** The lockfile install failed (often a lockfile out of date); workspaces run their own setup. */
export const autoSkipped = panel('skipped')
