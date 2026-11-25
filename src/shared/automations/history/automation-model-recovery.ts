import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import * as z from 'zod'
import type { AgentChatPermissionChoice } from '../../agent-launch/permissions/agent-chat-permission-mode'
import {
  AGENT_CHAT_PERMISSION_MODES,
  newChatPermissionMode
} from '../../agent-launch/permissions/agent-chat-permission-mode'
import type { AutomationBotTarget } from '../../automation-bot-target'
import type { Bot } from '../../bot-types'
import { botAutomationSetup, type BotAgentSetup } from '../../bots/bot-agent-setup'
import { parseStructuredLaunchSeedOptions } from '../../native-chat/input/session-options/native-chat-session-option-defaults'
import { ChoicePatch } from '../../rpc-contract/agent-launch/agent-launch-settings-params'

export type AutomationModelRecoveryInput = {
  id: string
  runId: string
  expectedTarget: string
  model: string
}

export type AutomationModelRecoverySelection = {
  model: string | null
  permission: AgentChatPermissionChoice | null
}

export type AutomationModelRecoveryProjection = AutomationModelRecoverySelection & {
  setupFingerprint: string
}

const recoveryModel = ChoicePatch.shape.model
  .unwrap()
  .refine((model) => model === null || parseStructuredLaunchSeedOptions({ model })?.model === model)

const recoveryProjection = z.object({
  model: recoveryModel,
  permission: z.union([z.enum(AGENT_CHAT_PERMISSION_MODES), z.literal('own'), z.null()]),
  setupFingerprint: z.string()
})

export function isReadableAutomationRecoveryModel(model: string | null): boolean {
  return recoveryModel.safeParse(model).success
}

export function readAutomationModelRecoveryProjection(
  value: unknown,
  agent: BotAgentSetup['agent'],
  expectedSetup: string
): AutomationModelRecoverySelection | undefined {
  const parsed = recoveryProjection.safeParse(value)
  if (!parsed.success) {
    return undefined
  }
  const { model, permission, setupFingerprint } = parsed.data
  if (
    setupFingerprint !== expectedSetup ||
    newChatPermissionMode(agent, permission) !== permission
  ) {
    return undefined
  }
  return { model, permission }
}

function sortedLaunchOptions(launch: BotAgentSetup['launch']): [string, string][] {
  const options = launch?.options ?? {}
  return Object.keys(options)
    .sort()
    .map((key) => [key, options[key]])
}

function fingerprint(fields: readonly unknown[]): string {
  return bytesToHex(sha256(JSON.stringify(fields)))
}

/** Attribute a read to the exact configured setup, before applying inherited Settings. */
export function automationModelRecoverySetupFingerprint(
  setup: BotAgentSetup & { own: boolean },
  bot: Pick<Bot, 'id' | 'permissionMode'>
): string {
  return fingerprint([
    bot.id,
    setup.own,
    setup.agent,
    setup.launch?.model,
    sortedLaunchOptions(setup.launch),
    bot.permissionMode
  ])
}

export type AutomationModelRecoveryResult =
  | { status: 'changed' | 'busy' | 'unconfirmed' | 'unsupported' }
  | { status: 'saved'; rerun: 'skipped' | 'unconfirmed' }
  | { status: 'queued'; runId: string; newerModel?: true }

type RecoveryTargetBot = Pick<Bot, 'agent' | 'launch' | 'folderWorkspaceId' | 'permissionMode'>

function recoveryExecutionTargetFields(
  target: AutomationBotTarget,
  bot: RecoveryTargetBot,
  folderPath: string,
  permission: AutomationModelRecoverySelection['permission'],
  agent: BotAgentSetup['agent']
): readonly unknown[] {
  const { botId, runsIn, resultsTo, letBotReact } = target
  const destination =
    typeof resultsTo === 'string'
      ? resultsTo
      : 'channel' in resultsTo
        ? ['channel', resultsTo.channel, resultsTo.ref]
        : ['linearIssue', resultsTo.linearIssue, resultsTo.ref]
  return [
    botId,
    runsIn,
    destination,
    letBotReact === true,
    bot.folderWorkspaceId,
    folderPath,
    bot.permissionMode,
    permission,
    agent
  ]
}

/** Match the configured target the renderer saw before saving. */
export function automationModelRecoveryTarget(
  target: AutomationBotTarget,
  bot: RecoveryTargetBot,
  folderPath: string,
  permission: AutomationModelRecoverySelection['permission']
): string {
  const { agent, launch } = botAutomationSetup(target, bot)
  return fingerprint([
    ...recoveryExecutionTargetFields(target, bot, folderPath, permission, agent),
    sortedLaunchOptions(launch)
  ])
}

/** After saving, the effective launch options are compared separately at admission. */
export function automationModelRecoveryExecutionTarget(
  target: AutomationBotTarget,
  bot: RecoveryTargetBot,
  folderPath: string,
  permission: AutomationModelRecoverySelection['permission']
): string {
  return fingerprint(recoveryExecutionTargetFields(target, bot, folderPath, permission, bot.agent))
}
