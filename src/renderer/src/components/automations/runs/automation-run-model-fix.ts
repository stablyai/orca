import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { peekRuntimeEnvironmentCapability } from '@/runtime/rpc/compatibility/runtime-compatibility-cache'
import { useRuntimeHostStatusViewSelector } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import { AUTOMATION_MODEL_RECOVERY_RUNTIME_CAPABILITY } from '../../../../../shared/automations/automation-runtime-capabilities'
import type { Automation } from '../../../../../shared/automations/automation-definition'
import type { AutomationModelRecoveryResult } from '../../../../../shared/automations/history/automation-model-recovery'
import type { AutomationRun } from '../../../../../shared/automations/history/automation-run'
import {
  isFailedAutomationRunModel,
  matchesAutomationRunModelFingerprint
} from '../../../../../shared/automations/history/automation-run-model-failure'
import type { Bot } from '../../../../../shared/bot-types'
import { botAutomationSetup } from '../../../../../shared/bots/bot-agent-setup'
import { parseExecutionHostId } from '../../../../../shared/execution-host/execution-host'

export type AutomationRunModelOption = { id: string; label: string }
export type AutomationRunModelConfirmation = { model: string; newerModel?: true }

export function useAutomationModelRecoveryUnsupported(hostId: Bot['hostId'] | undefined): boolean {
  const host = hostId && parseExecutionHostId(hostId)
  const environmentId = host && host.kind === 'runtime' ? host.environmentId : null
  return useRuntimeHostStatusViewSelector(environmentId, (entry) => {
    const capability = AUTOMATION_MODEL_RECOVERY_RUNTIME_CAPABILITY
    if (entry?.status) {
      return !entry.status.capabilities?.includes(capability)
    }
    return (
      environmentId !== null &&
      peekRuntimeEnvironmentCapability(environmentId, capability) === false
    )
  })
}

export function automationRunModelFix({
  run,
  automation,
  bot,
  canRerun,
  defaultModel
}: {
  run: Pick<AutomationRun, 'status' | 'errorCode' | 'errorParams'>
  automation: Pick<Automation, 'bot'> | null
  bot: Pick<Bot, 'agent' | 'launch'> | null
  canRerun: boolean
  defaultModel?: string | null
}) {
  const target = automation?.bot
  if (
    run.status !== 'dispatch_failed' ||
    run.errorCode !== 'agentModelUnavailable' ||
    !canRerun ||
    !target ||
    !bot ||
    target.runsIn !== 'new'
  ) {
    return null
  }
  const setup = botAutomationSetup(target, bot)
  if (run.errorParams?.agent !== setup.agent) {
    return null
  }
  const currentModel =
    defaultModel === undefined ? setup.launch?.model : (defaultModel ?? undefined)
  const currentModelFailed =
    currentModel !== undefined && isFailedAutomationRunModel(currentModel, run.errorParams)
  return {
    agent: setup.agent,
    setup,
    currentModel,
    currentModelFailed,
    modelChanged:
      currentModel !== undefined &&
      matchesAutomationRunModelFingerprint(currentModel, run.errorParams) === false,
    failureParams: run.errorParams
  }
}

export function showAutomationModelRecoveryResult(
  result: Exclude<AutomationModelRecoveryResult, { status: 'queued' }>,
  hostLabel?: string
): void {
  switch (result.status) {
    case 'changed':
      toast.error(
        translate(
          'automations.runModelFix.changed',
          "This automation changed, so the model wasn't saved. Use Edit to change it."
        )
      )
      break
    case 'busy':
      toast(translate('automations.runModelFix.busy', 'A model change is already in progress.'))
      break
    case 'unsupported':
      toast.error(
        translate(
          'automations.runModelFix.unsupported',
          'Update Orca on {{host}} to switch models.',
          {
            host:
              hostLabel?.trim() ||
              translate('automations.runModelFix.thisComputer', 'this computer')
          }
        )
      )
      break
    case 'unconfirmed':
      toast.error(
        translate(
          'automations.runModelFix.unconfirmed',
          "Couldn't confirm the model change. Check the automation before rerunning."
        )
      )
      break
    case 'saved':
      toast.error(
        result.rerun === 'skipped'
          ? translate('automations.runModelFix.rerunFailed', "Model saved. Rerun didn't start.")
          : translate(
              'automations.runModelFix.rerunUnconfirmed',
              "Model saved. Couldn't confirm the rerun."
            )
      )
      break
  }
}
