import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type {
  ManagedRuntimeInstallState,
  ManagedRuntimeOperation
} from '../../../../shared/managed-runtime-install'
import { megabytes, type ManagedRuntimeInstallAction } from './managed-runtime-install-view'

/** Hero fills an empty chat pane; strip sits above the composer. Both render the same host snapshot. */
export type ManagedRuntimeInstallLayout = 'hero' | 'strip'

export type ManagedRuntimeInstallCardStep = { label: string; state: 'done' | 'current' | 'todo' }

export type ManagedRuntimeInstallCard = {
  tone: 'offer' | 'running' | 'failed' | 'cancelled'
  title: string
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

function stepLabels(t: Translate = translate): string[] {
  return [
    t('components.managed-runtime.stepDownload', 'Download'),
    t('components.managed-runtime.stepUnpack', 'Unpack'),
    t('components.managed-runtime.stepCheck', 'Check')
  ]
}

function runningCard(
  operation: ManagedRuntimeOperation,
  agent: string,
  cancelling: boolean,
  t: Translate = translate
): ManagedRuntimeInstallCard | null {
  const current = STEP_PHASES.indexOf(operation.phase)
  if (current === -1) {
    return null
  }
  const { downloadedBytes: done, totalBytes: total } = operation
  const percent = current === 0 && total ? Math.min(100, (done / total) * 100) : null
  const detail =
    current === 1
      ? t('components.managed-runtime.unpackingDetail', 'Unpacking the runtime')
      : current === 2
        ? t('components.managed-runtime.checkingDetail', 'Checking the downloaded runtime')
        : total === null
          ? t('components.managed-runtime.downloading', 'Downloading {{done}} MB.', {
              done: megabytes(done)
            })
          : t('components.managed-runtime.progressOf', '{{done}} of {{total}} MB', {
              done: megabytes(done),
              total: megabytes(total)
            })
  const cancellingText = t('components.managed-runtime.cancelling', 'Cancelling…')
  const title = cancelling
    ? cancellingText
    : current === 0
      ? t('components.managed-runtime.downloadingTitle', 'Downloading {{agent}}', { agent })
      : current === 1
        ? t('components.managed-runtime.unpackingTitle', 'Unpacking {{agent}}', { agent })
        : t('components.managed-runtime.checkingTitle', 'Checking the download')
  return {
    tone: 'running',
    title,
    detail: null,
    progress: {
      percent,
      detail,
      percentText: percent === null ? null : `${Math.round(percent)}%`
    },
    steps: stepLabels(t).map((label, index) => ({
      label,
      state: index < current ? 'done' : index === current ? 'current' : 'todo'
    })),
    hint: null,
    action: {
      kind: 'cancel',
      label: cancelling ? cancellingText : t('components.managed-runtime.cancelShort', 'Cancel'),
      operationId: operation.id
    }
  }
}

function offerDetail(
  state: ManagedRuntimeInstallState,
  agent: string,
  hero: boolean,
  size: string | null,
  t: Translate = translate
): string | null {
  if (state.damaged) {
    return t('components.managed-runtime.damaged', 'This copy of {{agent}} is damaged.', {
      agent
    })
  }
  if (!hero) {
    return size === null
      ? null
      : t(
          'components.managed-runtime.stripSize',
          '{{size}} MB download on the computer running this chat',
          { size }
        )
  }
  return size === null
    ? t(
        'components.managed-runtime.heroBodyNoSize',
        "One-time download. It's shared by {{agent}} chats on the computer running this chat.",
        { agent }
      )
    : t(
        'components.managed-runtime.heroBody',
        "One-time {{size}} MB download. It's shared by {{agent}} chats on the computer running this chat.",
        { size, agent }
      )
}

function offerCard(
  state: ManagedRuntimeInstallState,
  agent: string,
  hero: boolean,
  size: string | null,
  t: Translate = translate
): ManagedRuntimeInstallCard {
  const title = hero
    ? t('components.managed-runtime.installTitle', 'Install {{agent}} to start chatting', {
        agent
      })
    : t('components.managed-runtime.continueTitle', 'Install {{agent}} to continue', {
        agent
      })
  const label = hero
    ? t('components.managed-runtime.install', 'Install {{agent}}', { agent })
    : t('components.managed-runtime.installShort', 'Install')
  const hint = t('components.managed-runtime.settingsHint', 'Also in Settings › Agents')
  return {
    tone: 'offer',
    title,
    detail: offerDetail(state, agent, hero, size, t),
    progress: null,
    steps: null,
    hint: hero ? hint : null,
    action: { kind: 'install', label }
  }
}

/** Show local cancellation feedback only until this surface’s pending Cancel request settles. */
export function managedRuntimeInstallCard(
  state: ManagedRuntimeInstallState,
  agent: string,
  layout: ManagedRuntimeInstallLayout,
  cancelling = false,
  t: Translate = translate
): ManagedRuntimeInstallCard {
  const { operation } = state
  const running = operation ? runningCard(operation, agent, cancelling, t) : null
  if (running) {
    return running
  }
  const hero = layout === 'hero'
  const size = state.downloadBytes ? String(Math.ceil(state.downloadBytes / 1_000_000)) : null
  const sizeHint =
    hero && size !== null
      ? t('components.managed-runtime.downloadSize', '{{size}} MB download.', { size })
      : null
  const install = (label: string): ManagedRuntimeInstallAction => ({ kind: 'install', label })
  const retry = t('components.managed-runtime.retry', 'Retry installation')
  if (operation?.kind === 'install' && operation.phase === 'cancelled') {
    return {
      tone: 'cancelled',
      title: t('components.managed-runtime.cancelledTitle', 'Installation cancelled'),
      detail: t('components.managed-runtime.cancelledBody', 'Nothing was installed.'),
      progress: null,
      steps: null,
      hint: sizeHint,
      action: install(retry)
    }
  }
  if (operation?.kind === 'install' && operation.phase === 'failed') {
    return {
      tone: 'failed',
      title: t('components.managed-runtime.failedTitle', "Couldn't install {{agent}}", {
        agent
      }),
      detail:
        operation.error ??
        t('components.managed-runtime.failed', 'Installation failed. Try again.'),
      progress: null,
      steps: null,
      hint: sizeHint,
      action: install(t('components.managed-runtime.tryAgain', 'Try again'))
    }
  }
  if (!state.available) {
    return {
      tone: 'offer',
      title: t(
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
  return offerCard(state, agent, hero, size, t)
}
