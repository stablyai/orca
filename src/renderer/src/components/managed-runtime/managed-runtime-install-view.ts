import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { ManagedRuntimeInstallState } from '../../../../shared/agent-launch/installation/managed-runtime-install'
import type { ManagedRuntimeInstallSnapshot } from '@/runtime/hosts/installation/managed-runtime-install-status'

export type ManagedRuntimeInstallAction =
  | { kind: 'install'; label: string }
  | { kind: 'cancel'; label: string; operationId: string }

export type ManagedRuntimeInstallView = {
  status: string | null
  /** What a screen reader hears for the status, when the visible text leaves out the agent the row sits under. */
  spokenStatus: string | null
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
  /** The status explains a problem (unavailable, damaged, outdated), so it wraps whole instead of truncating. */
  reason: boolean
  /** A step with no percent runs (unpacking, verifying, removing, a download of unknown size), so Settings shows a spinner. */
  busy: boolean
  note: string | null
}

export const megabytes = (bytes: number): string => (bytes / 1_000_000).toFixed(1)

const EMPTY: ManagedRuntimeInstallView = {
  status: null,
  spokenStatus: null,
  progress: null,
  error: null,
  action: null,
  menuAction: null,
  prominent: false,
  removable: false,
  removing: false,
  reason: false,
  busy: false,
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
    return { ...EMPTY, status, removing: true, busy: true }
  }
  if (phase !== 'downloading' && phase !== 'extracting' && phase !== 'verifying') {
    return null
  }
  const verifying = !cancelling && phase === 'verifying'
  // Only a known, positive size gives a percent; without one the download spins like the other steps.
  const sized = phase === 'downloading' && total !== null && total > 0 ? total : null
  const status = cancelling
    ? t('components.managed-runtime.cancelling', 'Cancelling…')
    : phase === 'extracting'
      ? t('components.managed-runtime.extracting', 'Unpacking…')
      : verifying
        ? t('components.managed-runtime.verifying', 'Verifying…')
        : sized === null
          ? t('components.managed-runtime.downloading', 'Downloading {{done}} MB.', {
              done: megabytes(done)
            })
          : t(
              'components.managed-runtime.downloadingOf',
              'Downloading {{done}} MB of {{total}} MB.',
              { done: megabytes(done), total: megabytes(sized) }
            )
  const label = t('components.managed-runtime.cancelShort', 'Cancel')
  return {
    ...EMPTY,
    status,
    spokenStatus: verifying
      ? t('components.managed-runtime.verifyingAgent', 'Verifying {{agent}}…', { agent })
      : null,
    progress: sized === null ? null : Math.min(100, (done / sized) * 100),
    busy: sized === null,
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
  // The host's own copy always runs while it exists, so installing Orca's would change nothing.
  // If that copy goes away, the row falls through to Not installed · Install. For the same reason
  // a failed install of Orca's copy isn't shown here (the chat card keeps its own Retry); a failed
  // Remove is, since the user asked for it from this row.
  if (state.source === 'external') {
    return {
      ...view(t('components.managed-runtime.external', 'Uses your own copy'), null),
      error: operation?.kind === 'install' ? null : error,
      spokenStatus: t('components.managed-runtime.externalAgent', 'Uses your own {{agent}}', {
        agent
      })
    }
  }
  if (state.installedVersion !== null && state.updatesAutomatically) {
    // Behind, the menu's install is an update to the newer release, so it says so.
    const menu = !state.available
      ? null
      : !state.installedCurrent && state.version !== null
        ? t('components.managed-runtime.updateTo', 'Update to {{version}}', {
            version: state.version
          })
        : t('components.managed-runtime.reinstall', 'Reinstall {{agent}}', { agent })
    return view(
      t('components.managed-runtime.installedByOrca', 'Installed by Orca · {{version}}', {
        version: state.installedVersion
      }),
      null,
      null,
      menu
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
    const status = t(
      'components.managed-runtime.installedByOrca',
      'Installed by Orca · {{version}}',
      {
        version: state.installedVersion
      }
    )
    return state.installedCurrent
      ? view(status, null, null, label)
      : { ...view(status, label), prominent: true, reason: true }
  }
  if (!state.available) {
    return {
      ...view(
        t('components.managed-runtime.unavailable', '{{agent}} is not available on this host.', {
          agent
        }),
        null
      ),
      reason: true
    }
  }
  if (state.damaged) {
    const status = t('components.managed-runtime.damaged', 'This copy of {{agent}} is damaged.', {
      agent
    })
    const label = t('components.managed-runtime.reinstallShort', 'Reinstall')
    return { ...view(status, label), prominent: true, reason: true }
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
  return view.action !== null || view.error !== null || view.removing
}
