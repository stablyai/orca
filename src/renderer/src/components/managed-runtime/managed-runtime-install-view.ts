import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { ManagedRuntimeInstallState } from '../../../../shared/managed-runtime-install'
import type { ManagedRuntimeInstallSnapshot } from '@/runtime/hosts/installation/managed-runtime-install-status'

export type ManagedRuntimeInstallAction =
  | { kind: 'install'; label: string }
  | { kind: 'cancel'; label: string; operationId: string }

export type ManagedRuntimeInstallView = {
  status: string | null
  /** Percent downloaded, while a download of known size runs. */
  progress: number | null
  error: string | null
  action: ManagedRuntimeInstallAction | null
  menuAction: ManagedRuntimeInstallAction | null
  /** Settings draws this action as a button instead of inline text. */
  prominent: boolean
  /** Settings may offer to delete the copy Orca installed: one is there and nothing runs. */
  removable: boolean
  removing: boolean
  note: string | null
}

export const megabytes = (bytes: number): string => (bytes / 1_000_000).toFixed(1)

const EMPTY: ManagedRuntimeInstallView = {
  status: null,
  progress: null,
  error: null,
  action: null,
  menuAction: null,
  prominent: false,
  removable: false,
  removing: false,
  note: null
}

function runningView(
  operation: NonNullable<ManagedRuntimeInstallState['operation']>,
  agent: string,
  cancelling: boolean,
  t: Translate = translate
): ManagedRuntimeInstallView | null {
  const { phase, downloadedBytes: done, totalBytes: total } = operation
  if (phase === 'removing') {
    const status = t('components.managed-runtime.removing', 'Removing…')
    return { ...EMPTY, status, removing: true }
  }
  if (phase !== 'downloading' && phase !== 'extracting' && phase !== 'verifying') {
    return null
  }
  const status = cancelling
    ? t('components.managed-runtime.cancelling', 'Cancelling…')
    : phase === 'extracting'
      ? t('components.managed-runtime.extracting', 'Extracting {{agent}}.', { agent })
      : phase === 'verifying'
        ? t('components.managed-runtime.verifying', 'Checking the downloaded runtime.')
        : total === null
          ? t('components.managed-runtime.downloading', 'Downloading {{done}} MB.', {
              done: megabytes(done)
            })
          : t(
              'components.managed-runtime.downloadingOf',
              'Downloading {{done}} MB of {{total}} MB.',
              { done: megabytes(done), total: megabytes(total) }
            )
  const label = t('components.managed-runtime.cancelShort', 'Cancel')
  return {
    ...EMPTY,
    status,
    progress: phase === 'downloading' && total ? Math.min(100, (done / total) * 100) : null,
    action: { kind: 'cancel', label, operationId: operation.id }
  }
}

function settledView(
  state: ManagedRuntimeInstallState,
  agent: string,
  t: Translate = translate
): ManagedRuntimeInstallView {
  const { operation } = state
  const failed = operation?.phase === 'failed'
  const error = failed
    ? (operation.error ??
      (operation.kind === 'install'
        ? t('components.managed-runtime.failedTitle', "Couldn't install {{agent}}", {
            agent
          })
        : t('components.managed-runtime.failed', 'Installation failed. Try again.')))
    : null
  const view = (
    status: string | null,
    label: string | null,
    note: string | null = null,
    menuLabel: string | null = null
  ): ManagedRuntimeInstallView => ({
    ...EMPTY,
    status,
    error,
    action: label === null ? null : { kind: 'install', label },
    menuAction: menuLabel === null ? null : { kind: 'install', label: menuLabel },
    removable: state.canRemove === true,
    note
  })
  const install = t('components.managed-runtime.installShort', 'Install')
  // A copy found outside Orca already runs; Orca's own, once installed, runs first.
  if (state.source === 'external') {
    return view(
      t('components.managed-runtime.external', 'Uses the copy of {{agent}} found on this host.', {
        agent
      }),
      state.available ? t('components.managed-runtime.installManaged', "Install Orca's copy") : null
    )
  }
  if (state.installedVersion !== null) {
    const reinstall = t('components.managed-runtime.reinstall', 'Reinstall {{agent}}', {
      agent
    })
    // Reinstalling a current copy checks it and repairs what's missing, so it needs the pin.
    const label = !state.installedCurrent
      ? t('components.managed-runtime.update', 'Update')
      : state.available
        ? reinstall
        : null
    const status = t('components.managed-runtime.installed', 'Installed')
    return state.installedCurrent
      ? view(status, null, null, label)
      : { ...view(status, label), prominent: true }
  }
  if (!state.available) {
    return view(
      t('components.managed-runtime.unavailable', '{{agent}} is not available on this host.', {
        agent
      }),
      null
    )
  }
  if (state.damaged) {
    const status = t('components.managed-runtime.damaged', 'This copy of {{agent}} is damaged.', {
      agent
    })
    const label = t('components.managed-runtime.reinstallShort', 'Reinstall')
    return { ...view(status, label), prominent: true }
  }
  const retry = t('components.managed-runtime.tryAgain', 'Try again')
  if (operation?.kind === 'install' && operation.phase === 'cancelled') {
    return view(t('components.managed-runtime.cancelled', 'Installation cancelled.'), retry)
  }
  if (operation?.kind === 'install' && failed) {
    return view(null, retry)
  }
  const size = state.downloadBytes
  return {
    ...view(
      t('components.managed-runtime.notInstalled', 'Not installed.'),
      install,
      size === undefined
        ? null
        : t('components.managed-runtime.downloadSize', '{{size}} MB download.', {
            size: Math.ceil(size / 1_000_000)
          })
    ),
    prominent: true
  }
}

/** Show local cancellation feedback only until this row’s pending Cancel request settles. */
export function managedRuntimeInstallView(
  snapshot: ManagedRuntimeInstallSnapshot,
  agent: string,
  cancelling = false,
  t: Translate = translate
): ManagedRuntimeInstallView {
  if (snapshot.kind !== 'known') {
    return {
      ...EMPTY,
      error:
        snapshot.kind === 'readFailed'
          ? t(
              'components.managed-runtime.readFailed',
              'Could not check {{agent}} on this host. Retrying.',
              { agent }
            )
          : null
    }
  }
  const { operation } = snapshot.state
  return (
    (operation ? runningView(operation, agent, cancelling, t) : null) ??
    settledView(snapshot.state, agent, t)
  )
}

/** Whether Orca's copy still needs the user: missing, outdated, damaged, failed, installing, or unreadable. */
export function managedRuntimeInstallPending(snapshot: ManagedRuntimeInstallSnapshot): boolean {
  if (snapshot.kind === 'readFailed') {
    return true
  }
  if (snapshot.kind !== 'known') {
    return false
  }
  const view = managedRuntimeInstallView(snapshot, '')
  // A working external copy needs nothing unless Orca's own install is running or failed.
  if (snapshot.state.source === 'external') {
    return view.action?.kind === 'cancel' || view.removing || view.error !== null
  }
  return view.action !== null || view.error !== null
}
