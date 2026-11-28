import type {
  ManagedRuntimeInstallState,
  ManagedRuntimeOperation
} from '../../../../shared/agent-launch/installation/managed-runtime-install'
import { i18n } from '@/i18n/i18n'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { ManagedRuntimeInstallRow } from './ManagedRuntimeInstallRow'

// Settings at its narrowest: a 600px window, less the 280px nav and the page's side padding.
const NARROWEST_SETTINGS = 256

const base: ManagedRuntimeInstallState = {
  agent: 'opencode',
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

function row(
  state: ManagedRuntimeInstallState,
  agentLabel = 'OpenCode',
  width = NARROWEST_SETTINGS
) {
  return defineFixture({
    width,
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
// A typical Settings width, where the bar fits on the line beside the download count.
export const downloadingWide = row(installing('downloading'), 'OpenCode', 520)
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
export const notInstalled = row(base)
export const failed = row({
  ...base,
  operation: {
    id: 'op-1',
    kind: 'install',
    phase: 'failed',
    downloadedBytes: 0,
    totalBytes: null,
    error: "Couldn't reach the download server. Check your connection."
  }
})

export const externalInstallFailed = row({
  ...base,
  source: 'external',
  operation: {
    id: 'op-1',
    kind: 'install',
    phase: 'failed',
    downloadedBytes: 0,
    totalBytes: null,
    error: "Couldn't reach the download server. Check your connection."
  }
})
export const downloadingUnknownSize = row({
  ...base,
  operation: {
    id: 'op-1',
    kind: 'install',
    phase: 'downloading',
    downloadedBytes: 41_200_000,
    totalBytes: null
  }
})
export const unavailable = row({ ...base, available: false })
export const updateAvailable = row({
  ...base,
  source: 'managed',
  version: '1.6.0',
  installedVersion: '1.5.0',
  installedCurrent: false,
  canRemove: true
})

// Fixture pages share one i18n instance; run these shots last, then restart the server.
function localized(state: ManagedRuntimeInstallState, language: string) {
  return defineFixture({
    ...row(state),
    interact: async () => {
      await i18n.changeLanguage(language)
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
  })
}
export const germanExternal = localized({ ...base, source: 'external' }, 'de')
export const germanVerifying = localized(installing('verifying'), 'de')
export const japaneseExternal = localized({ ...base, source: 'external' }, 'ja')
export const japaneseVerifying = localized(installing('verifying'), 'ja')
export const russianExternal = localized({ ...base, source: 'external' }, 'ru')
export const russianVerifying = localized(installing('verifying'), 'ru')
