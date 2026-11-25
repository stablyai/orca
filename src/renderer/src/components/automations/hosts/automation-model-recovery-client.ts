import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import { AUTOMATION_MODEL_RECOVERY_RUNTIME_CAPABILITY } from '../../../../../shared/automations/automation-runtime-capabilities'
import {
  readAutomationModelRecoveryProjection,
  type AutomationModelRecoveryInput,
  type AutomationModelRecoveryResult,
  type AutomationModelRecoverySelection
} from '../../../../../shared/automations/history/automation-model-recovery'
import type { BotAgent } from '../../../../../shared/bot-types'
import type { AutomationOwnerRef } from '../../../../../shared/automations/ownership/automation-owner-ref'
import {
  assertAuthorityCapability,
  AutomationHostScopeUnsupportedError
} from './automation-capability-probe'
import { callAuthority, ownerPrecondition } from './automation-scoped-list-client'

export async function readAutomationRecoverySelectionForOwner(
  owner: AutomationOwnerRef,
  id: string,
  agent: BotAgent,
  expectedSetup: string
): Promise<AutomationModelRecoverySelection | undefined> {
  const { recoverySelection } = await callAuthority<{
    recoverySelection?: unknown
  }>(owner.authority, 'automation.show', {
    id,
    expectedOwner: ownerPrecondition(owner),
    modelRecovery: true
  })
  return readAutomationModelRecoveryProjection(recoverySelection, agent, expectedSetup)
}

export async function recoverAutomationModelForOwner(
  owner: AutomationOwnerRef,
  input: AutomationModelRecoveryInput
): Promise<AutomationModelRecoveryResult> {
  try {
    await assertAuthorityCapability(
      owner.authority,
      AUTOMATION_MODEL_RECOVERY_RUNTIME_CAPABILITY,
      AUTOMATION_MODEL_RECOVERY_RUNTIME_CAPABILITY,
      { cacheConfirmation: false }
    )
    return await callAuthority(owner.authority, 'automation.recoverModel', {
      ...input,
      expectedOwner: ownerPrecondition(owner)
    })
  } catch (error) {
    if (
      error instanceof AutomationHostScopeUnsupportedError ||
      (error instanceof RuntimeRpcCallError && error.code === 'method_not_found')
    ) {
      return { status: 'unsupported' }
    }
    throw error
  }
}
