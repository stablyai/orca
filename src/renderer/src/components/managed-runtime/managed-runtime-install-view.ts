import { translate } from '@/i18n/i18n'
import type { ManagedRuntimeInstallState } from '../../../../shared/managed-runtime-install'
import type { ManagedRuntimeInstallSnapshot } from '@/runtime/managed-runtime-install-status'

export type ManagedRuntimeInstallAction =
  | { kind: 'install'; label: string }
  | { kind: 'cancel'; label: string; operationId: string }

export type ManagedRuntimeInstallView = {
  status: string | null
  /** Percent downloaded, while a download of known size runs. */
  progress: number | null
  /** Why the last operation or status read failed. */
  error: string | null
  action: ManagedRuntimeInstallAction | null
  /** The action is the first step to using the agent, so Settings draws it as a button. */
  prominent: boolean
  /** Settings may offer to delete the copy Orca installed: one is there and nothing runs. */
  removable: boolean
  /** A removal runs, so the line shows it as work in progress. */
  removing: boolean
  /** Said after the actions, such as what Install downloads. */
  note: string | null
}

export const megabytes = (bytes: number): string => (bytes / 1_000_000).toFixed(1)

const EMPTY: ManagedRuntimeInstallView = {
  status: null,
  progress: null,
  error: null,
  action: null,
  prominent: false,
  removable: false,
  removing: false,
  note: null
}

function runningView(
  operation: NonNullable<ManagedRuntimeInstallState['operation']>,
  agent: string,
  cancelling: boolean
): ManagedRuntimeInstallView | null {
  const { phase, downloadedBytes: done, totalBytes: total } = operation
  if (phase === 'removing') {
    const status = translate('components.managed-runtime.removing', 'Removing…')
    return { ...EMPTY, status, removing: true }
  }
  if (phase !== 'downloading' && phase !== 'extracting' && phase !== 'verifying') {
    return null
  }
  const status = cancelling
    ? translate('components.managed-runtime.cancelling', 'Cancelling…')
    : phase === 'extracting'
      ? translate('components.managed-runtime.extracting', 'Extracting {{agent}}.', { agent })
      : phase === 'verifying'
        ? translate('components.managed-runtime.verifying', 'Checking the downloaded runtime.')
        : total === null
          ? translate('components.managed-runtime.downloading', 'Downloading {{done}} MB.', {
              done: megabytes(done)
            })
          : translate(
              'components.managed-runtime.downloadingOf',
              'Downloading {{done}} MB of {{total}} MB.',
              { done: megabytes(done), total: megabytes(total) }
            )
  const label = translate('components.managed-runtime.cancelShort', 'Cancel')
  return {
    ...EMPTY,
    status,
    progress: phase === 'downloading' && total ? Math.min(100, (done / total) * 100) : null,
    action: { kind: 'cancel', label, operationId: operation.id }
  }
}

function settledView(state: ManagedRuntimeInstallState, agent: string): ManagedRuntimeInstallView {
  const { operation } = state
  const failed = operation?.phase === 'failed'
  const error = failed
    ? (operation.error ??
      (operation.kind === 'install'
        ? translate('components.managed-runtime.failedTitle', "Couldn't install {{agent}}", {
            agent
          })
        : translate('components.managed-runtime.failed', 'Installation failed. Try again.')))
    : null
  const view = (
    status: string | null,
    label: string | null,
    note: string | null = null
  ): ManagedRuntimeInstallView => ({
    ...EMPTY,
    status,
    error,
    action: label === null ? null : { kind: 'install', label },
    removable: state.canRemove === true,
    note
  })
  const install = translate('components.managed-runtime.installShort', 'Install')
  // A copy found outside Orca already runs; Orca's own, once installed, runs first.
  if (state.source === 'external') {
    return view(
      translate(
        'components.managed-runtime.external',
        'Uses the copy of {{agent}} found on this host.',
        { agent }
      ),
      state.available
        ? translate('components.managed-runtime.installManaged', "Install Orca's copy")
        : null
    )
  }
  if (state.installedVersion !== null) {
    // A healthy current copy needs nothing; Remove is its only action.
    const label = state.installedCurrent
      ? null
      : translate('components.managed-runtime.update', 'Update')
    return view(translate('components.managed-runtime.installed', 'Installed.'), label)
  }
  if (!state.available) {
    return view(
      translate(
        'components.managed-runtime.unavailable',
        '{{agent}} is not available on this host.',
        { agent }
      ),
      null
    )
  }
  if (state.damaged) {
    return view(
      translate('components.managed-runtime.damaged', 'This copy of {{agent}} is damaged.', {
        agent
      }),
      translate('components.managed-runtime.reinstall', 'Reinstall')
    )
  }
  const retry = translate('components.managed-runtime.tryAgain', 'Try again')
  if (operation?.kind === 'install' && operation.phase === 'cancelled') {
    return view(translate('components.managed-runtime.cancelled', 'Installation cancelled.'), retry)
  }
  // A failed install says only why, beside Try again.
  if (operation?.kind === 'install' && failed) {
    return view(null, retry)
  }
  // The size says what Install costs.
  const size = state.downloadBytes
  return {
    ...view(
      translate('components.managed-runtime.notInstalled', 'Not installed.'),
      install,
      size === undefined
        ? null
        : translate('components.managed-runtime.downloadSize', '{{size}} MB download.', {
            size: Math.ceil(size / 1_000_000)
          })
    ),
    prominent: true
  }
}

/** What an install row says and offers for the host's answer. `cancelling`: this row's Cancel is
 *  still out, so it says so until the host's cancel settles. */
export function managedRuntimeInstallView(
  snapshot: ManagedRuntimeInstallSnapshot,
  agent: string,
  cancelling = false
): ManagedRuntimeInstallView {
  if (snapshot.kind !== 'known') {
    return {
      ...EMPTY,
      error:
        snapshot.kind === 'readFailed'
          ? translate(
              'components.managed-runtime.readFailed',
              'Could not check {{agent}} on this host. Retrying.',
              { agent }
            )
          : null
    }
  }
  const { operation } = snapshot.state
  return (
    (operation ? runningView(operation, agent, cancelling) : null) ??
    settledView(snapshot.state, agent)
  )
}
