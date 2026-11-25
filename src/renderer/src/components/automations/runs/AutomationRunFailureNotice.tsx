import type { ReactNode } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import type { Automation } from '../../../../../shared/automations/automation-definition'
import type { AutomationRun } from '../../../../../shared/automations/history/automation-run'
import type { Bot } from '../../../../../shared/bot-types'
import { getAgentLabel } from '../authoring/automation-draft-model'
import { AutomationRunErrorNotice } from '../automation-page-parts'
import type { AutomationRunModelPicker } from './AutomationRunModelPicker'
import {
  automationRunModelFix,
  useAutomationModelRecoveryUnsupported,
  type AutomationRunModelOption
} from './automation-run-model-fix'
import type { AutomationRecoveryModelRead } from './use-automation-recovery-model'

export function AutomationRunFailureNotice({
  run,
  automation,
  bot,
  defaultModel,
  modelRead,
  canRerun,
  isRerunPending,
  isModelFixPending,
  errorText,
  errorTitle,
  modelPicker: ModelPicker,
  onPickModel
}: {
  run: AutomationRun
  automation: Automation | null
  bot: Pick<Bot, 'agent' | 'launch' | 'hostId' | 'folderWorkspaceId'> | null
  defaultModel?: string | null
  modelRead: AutomationRecoveryModelRead['status']
  canRerun: boolean
  isRerunPending: boolean
  isModelFixPending: boolean
  errorText: string | null
  /** The whole error when `errorText` shortened a long model name. */
  errorTitle?: string
  modelPicker: typeof AutomationRunModelPicker
  onPickModel?: (model: AutomationRunModelOption) => void
}) {
  const t = useTranslate()
  const modelFix = onPickModel
    ? automationRunModelFix({ run, automation, bot, canRerun, defaultModel })
    : null
  const recoveryUnsupported = useAutomationModelRecoveryUnsupported(
    modelFix ? bot?.hostId : undefined
  )
  const modelReadUnavailable = Boolean(
    modelFix && (modelRead === 'loading' || modelRead === 'unavailable') && !recoveryUnsupported
  )
  const compactModelError =
    !recoveryUnsupported && modelRead === 'ready' && modelFix?.modelChanged
      ? t('automations.runModelFix.modelChanged', 'Model changed.')
      : t('automations.runModelFix.modelUnavailable', 'Model unavailable.')
  const renderFailureNotice = (action?: ReactNode) => (
    <AutomationRunErrorNotice
      action={action}
      compactError={action || recoveryUnsupported ? compactModelError : undefined}
      busy={isModelFixPending}
      errorTitle={errorTitle}
      label={
        modelReadUnavailable
          ? ''
          : t('auto.components.automations.runIdentity.runFailed', 'Run failed.')
      }
      error={
        modelReadUnavailable
          ? compactModelError
          : action && modelFix?.currentModelFailed
            ? t('automations.runModelFix.errorWithPicker', "{{agent}} couldn't use this model.", {
                agent: getAgentLabel(modelFix.agent)
              })
            : (errorText ??
              t(
                'auto.components.automations.runIdentity.noFailureReason',
                'This run did not start, and no reason was recorded.'
              ))
      }
    />
  )
  return modelFix && bot && onPickModel && !recoveryUnsupported && !modelReadUnavailable ? (
    <ModelPicker
      bot={bot}
      agent={modelFix.agent}
      currentModel={modelFix.currentModel}
      failureParams={modelFix.failureParams}
      disabled={modelRead !== 'ready' || isModelFixPending || isRerunPending}
      renderNotice={renderFailureNotice}
      onPick={onPickModel}
    />
  ) : (
    renderFailureNotice()
  )
}
