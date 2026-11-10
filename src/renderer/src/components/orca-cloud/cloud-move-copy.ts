// Copy shared by the "Move to this computer" view and its dialog host.
import { getIntlLocale } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { CloudMoveState, CloudMoveStep } from '@/lib/orca-cloud/orca-cloud-move-store'

export function cloudMoveStepLabel(step: CloudMoveStep, t: Translate): string {
  switch (step) {
    case 'waking':
      return t('orcaCloudMove.step.waking', 'Waking')
    case 'packing':
      return t('orcaCloudMove.step.packing', 'Packing')
    case 'downloading':
      return t('orcaCloudMove.step.downloading', 'Downloading')
    case 'creating':
      return t('orcaCloudMove.step.creating', 'Creating workspace')
    case 'applying':
      return t('orcaCloudMove.step.applying', 'Applying changes')
  }
}

export function formatMoveSize(bytes: number): string {
  const mb = bytes >= 1024 * 1024
  return new Intl.NumberFormat(getIntlLocale(), {
    style: 'unit',
    unit: mb ? 'megabyte' : 'kilobyte',
    maximumFractionDigits: mb ? 1 : 0
  }).format(mb ? bytes / (1024 * 1024) : Math.max(1, Math.ceil(bytes / 1024)))
}

export function cloudMoveTitle(state: CloudMoveState, t: Translate): string {
  switch (state.stage) {
    case 'running':
      return t('orcaCloudMove.title.running', 'Moving {{name}} to this computer', {
        name: state.name
      })
    case 'done':
      return t('orcaCloudMove.title.done', 'Moved to this computer')
    case 'failed':
      return t('orcaCloudMove.title.failed', 'Couldn’t move {{name}}', { name: state.name })
    case 'closed':
    case 'confirm':
      return t('orcaCloudMove.title.confirm', 'Move to this computer')
  }
}

/** Why the move stopped, one sentence per step (separate keys: no case-folding of translations). */
export function cloudMoveFailureCause(
  step: CloudMoveStep,
  timedOut: boolean,
  t: Translate
): string {
  if (timedOut) {
    switch (step) {
      case 'waking':
        return t(
          'orcaCloudMove.timeout.waking',
          'Waking the sandbox is taking too long, so Orca stopped waiting. Your files are safe; try again.'
        )
      case 'packing':
        return t(
          'orcaCloudMove.timeout.packing',
          'Packing the workspace is taking too long, so Orca stopped waiting. Your files are safe; try again.'
        )
      case 'downloading':
        return t(
          'orcaCloudMove.timeout.downloading',
          'The download is taking too long, so Orca stopped waiting. Your files are safe; try again.'
        )
      case 'creating':
        return t(
          'orcaCloudMove.timeout.creating',
          'Creating the local workspace is taking too long, so Orca stopped waiting.'
        )
      case 'applying':
        return t(
          'orcaCloudMove.timeout.applying',
          'Applying the changes is taking too long, so Orca stopped waiting.'
        )
    }
  }
  switch (step) {
    case 'waking':
      return t('orcaCloudMove.cause.waking', 'The sandbox didn’t wake up.')
    case 'packing':
      return t('orcaCloudMove.cause.packing', 'The workspace couldn’t be packed in the sandbox.')
    case 'downloading':
      return t('orcaCloudMove.cause.downloading', 'The download from the sandbox didn’t finish.')
    case 'creating':
      return t('orcaCloudMove.cause.creating', 'The local workspace couldn’t be created.')
    case 'applying':
      return t(
        'orcaCloudMove.cause.applying',
        'The changes couldn’t be applied to the local workspace.'
      )
  }
}
