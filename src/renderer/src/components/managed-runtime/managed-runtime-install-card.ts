import { translate } from '@/i18n/i18n'
import type {
  ManagedRuntimeInstallState,
  ManagedRuntimeOperation
} from '../../../../shared/managed-runtime-install'
import { megabytes, type ManagedRuntimeInstallAction } from './managed-runtime-install-view'

/** `hero`: the whole-pane message of a chat with no messages; `strip`: the slim line above the
 *  composer outside that pane. Both read one card, so they never disagree. */
export type ManagedRuntimeInstallLayout = 'hero' | 'strip'

export type ManagedRuntimeInstallCardStep = { label: string; state: 'done' | 'current' | 'todo' }

export type ManagedRuntimeInstallCard = {
  tone: 'offer' | 'running' | 'failed' | 'cancelled'
  title: string
  /** The sentence under the title: what it is, why it failed, or what ended. */
  detail: string | null
  /** `percent` is null while the size of what remains is unknown. */
  progress: { percent: number | null; detail: string; percentText: string | null } | null
  steps: ManagedRuntimeInstallCardStep[] | null
  hint: string | null
  action: ManagedRuntimeInstallAction | null
}

const STEP_PHASES: readonly ManagedRuntimeOperation['phase'][] = [
  'downloading',
  'extracting',
  'verifying'
]

function stepLabels(): string[] {
  return [
    translate('components.managed-runtime.stepDownload', 'Download'),
    translate('components.managed-runtime.stepUnpack', 'Unpack'),
    translate('components.managed-runtime.stepCheck', 'Check')
  ]
}

function runningCard(
  operation: ManagedRuntimeOperation,
  agent: string,
  cancelling: boolean
): ManagedRuntimeInstallCard | null {
  const current = STEP_PHASES.indexOf(operation.phase)
  if (current === -1) {
    return null
  }
  const { downloadedBytes: done, totalBytes: total } = operation
  const percent = current === 0 && total ? Math.min(100, (done / total) * 100) : null
  const detail =
    current === 1
      ? translate('components.managed-runtime.unpackingDetail', 'Unpacking the runtime')
      : current === 2
        ? translate('components.managed-runtime.checkingDetail', 'Checking the downloaded runtime')
        : total === null
          ? translate('components.managed-runtime.downloading', 'Downloading {{done}} MB.', {
              done: megabytes(done)
            })
          : translate('components.managed-runtime.progressOf', '{{done}} of {{total}} MB', {
              done: megabytes(done),
              total: megabytes(total)
            })
  const cancellingText = translate('components.managed-runtime.cancelling', 'Cancelling…')
  const title = cancelling
    ? cancellingText
    : current === 0
      ? translate('components.managed-runtime.downloadingTitle', 'Downloading {{agent}}', { agent })
      : current === 1
        ? translate('components.managed-runtime.unpackingTitle', 'Unpacking {{agent}}', { agent })
        : translate('components.managed-runtime.checkingTitle', 'Checking the download')
  return {
    tone: 'running',
    title,
    detail: null,
    progress: {
      percent,
      detail,
      percentText: percent === null ? null : `${Math.round(percent)}%`
    },
    steps: stepLabels().map((label, index) => ({
      label,
      state: index < current ? 'done' : index === current ? 'current' : 'todo'
    })),
    hint: null,
    action: {
      kind: 'cancel',
      label: cancelling
        ? cancellingText
        : translate('components.managed-runtime.cancelShort', 'Cancel'),
      operationId: operation.id
    }
  }
}

function offerDetail(
  state: ManagedRuntimeInstallState,
  agent: string,
  hero: boolean,
  size: string | null
): string | null {
  if (state.damaged) {
    return translate('components.managed-runtime.damaged', 'This copy of {{agent}} is damaged.', {
      agent
    })
  }
  if (!hero) {
    return size === null
      ? null
      : translate(
          'components.managed-runtime.stripSize',
          '{{size}} MB download on the computer running this chat',
          { size }
        )
  }
  return size === null
    ? translate(
        'components.managed-runtime.heroBodyNoSize',
        "One-time download. It's shared by {{agent}} chats on the computer running this chat.",
        { agent }
      )
    : translate(
        'components.managed-runtime.heroBody',
        "One-time {{size}} MB download. It's shared by {{agent}} chats on the computer running this chat.",
        { size, agent }
      )
}

function offerCard(
  state: ManagedRuntimeInstallState,
  agent: string,
  hero: boolean,
  size: string | null
): ManagedRuntimeInstallCard {
  const title = hero
    ? translate('components.managed-runtime.installTitle', 'Install {{agent}} to start chatting', {
        agent
      })
    : translate('components.managed-runtime.continueTitle', 'Install {{agent}} to continue', {
        agent
      })
  const label = hero
    ? translate('components.managed-runtime.install', 'Install {{agent}}', { agent })
    : translate('components.managed-runtime.installShort', 'Install')
  const hint = translate(
    'components.managed-runtime.settingsHint',
    'Also in Settings › Chat › Providers'
  )
  return {
    tone: 'offer',
    title,
    detail: offerDetail(state, agent, hero, size),
    progress: null,
    steps: null,
    hint: hero ? hint : null,
    action: { kind: 'install', label }
  }
}

/** What an install card says and offers for the host's answer. `cancelling`: this surface's Cancel
 *  is still out, so it says so until the host's cancel settles. */
export function managedRuntimeInstallCard(
  state: ManagedRuntimeInstallState,
  agent: string,
  layout: ManagedRuntimeInstallLayout,
  cancelling = false
): ManagedRuntimeInstallCard {
  const { operation } = state
  const running = operation ? runningCard(operation, agent, cancelling) : null
  if (running) {
    return running
  }
  const hero = layout === 'hero'
  const size = state.downloadBytes ? String(Math.ceil(state.downloadBytes / 1_000_000)) : null
  const sizeHint =
    hero && size !== null
      ? translate('components.managed-runtime.downloadSize', '{{size}} MB download.', { size })
      : null
  const install = (label: string): ManagedRuntimeInstallAction => ({ kind: 'install', label })
  const retry = translate('components.managed-runtime.retry', 'Retry installation')
  if (operation?.kind === 'install' && operation.phase === 'cancelled') {
    return {
      tone: 'cancelled',
      title: translate('components.managed-runtime.cancelledTitle', 'Installation cancelled'),
      detail: translate('components.managed-runtime.cancelledBody', 'Nothing was installed.'),
      progress: null,
      steps: null,
      hint: sizeHint,
      action: install(retry)
    }
  }
  if (operation?.kind === 'install' && operation.phase === 'failed') {
    return {
      tone: 'failed',
      title: translate('components.managed-runtime.failedTitle', "Couldn't install {{agent}}", {
        agent
      }),
      detail:
        operation.error ??
        translate('components.managed-runtime.failed', 'Installation failed. Try again.'),
      progress: null,
      steps: null,
      hint: sizeHint,
      action: install(translate('components.managed-runtime.tryAgain', 'Try again'))
    }
  }
  if (!state.available) {
    return {
      tone: 'offer',
      title: translate(
        'components.managed-runtime.unavailable',
        '{{agent}} is not available on this host.',
        { agent }
      ),
      detail: null,
      progress: null,
      steps: null,
      hint: null,
      action: null
    }
  }
  return offerCard(state, agent, hero, size)
}
