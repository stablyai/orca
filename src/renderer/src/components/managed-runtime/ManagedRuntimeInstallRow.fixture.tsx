import type {
  ManagedRuntimeInstallState,
  ManagedRuntimeOperation
} from '../../../../shared/agent-launch/installation/managed-runtime-install'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { ManagedRuntimeInstallRow } from './ManagedRuntimeInstallRow'

// Settings at its narrowest: a 600px window, less the 280px nav and the page's side padding.
const NARROWEST_SETTINGS = 256

const base: ManagedRuntimeInstallState = {
  agent: 'antigravity',
  revision: 1,
  available: true,
  version: '1.5.0',
  downloadBytes: 98_000_000,
  installedVersion: null,
  installedCurrent: false,
  canRemove: false,
  source: null,
  operation: null
}

function installing(phase: ManagedRuntimeOperation['phase']): ManagedRuntimeInstallState {
  return {
    ...base,
    operation: {
      id: 'op-1',
      kind: 'install',
      phase,
      downloadedBytes: 41_200_000,
      totalBytes: 98_000_000
    }
  }
}

function row(state: ManagedRuntimeInstallState, agentLabel = 'Antigravity') {
  return defineFixture({
    width: NARROWEST_SETTINGS,
    render: () => (
      <ManagedRuntimeInstallRow
        observation={{
          kind: 'active',
          subject: { target: { kind: 'local' }, runtimeId: null, agent: state.agent },
          snapshot: { kind: 'known', state },
          removable: true
        }}
        agentLabel={agentLabel}
      >
        {(line, actions) => (
          <div data-settings-row="" className="flex items-center justify-between gap-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Chat runtime</p>
              <div className="mt-0.5">{line}</div>
            </div>
            <div className="flex shrink-0 items-center gap-1">{actions}</div>
          </div>
        )}
      </ManagedRuntimeInstallRow>
    )
  })
}

export const downloading = row(installing('downloading'))
export const unpacking = row(installing('extracting'))
export const verifying = row(installing('verifying'))
export const externalWithoutOrcaCopy = row({ ...base, source: 'external' })
export const externalWithOrcaCopy = row({
  ...base,
  source: 'external',
  installedVersion: '1.5.0',
  installedCurrent: true,
  canRemove: true
})
export const installedByOrca = row({
  ...base,
  source: 'managed',
  installedVersion: '1.5.0',
  installedCurrent: true,
  updatesAutomatically: true,
  canRemove: true
})
const LONG_NAME = 'GitHub Copilot CLI'
export const verifyingLongName = row(installing('verifying'), LONG_NAME)
export const externalLongName = row({ ...base, source: 'external' }, LONG_NAME)
