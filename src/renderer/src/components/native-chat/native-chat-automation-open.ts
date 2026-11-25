// A chat's automation card opens beside its bot, on the transcript's host; one without a bot opens
// the Automations page there.
import type { BotAutomationOpen } from '@/components/bots/bot-automation-open'
import { getRuntimeTargetHostId } from '@/runtime/rpc/targets/runtime-client-target'
import type { Automation } from '../../../../shared/automations/automation-definition'
import type { NativeChatVisualOwner } from './media/visuals/native-chat-visual-owner'

export function automationOpenFromCard(
  owner: NativeChatVisualOwner | null,
  automation: Pick<Automation, 'id'> & { bot?: { botId: string } },
  runId: string | null,
  intent?: BotAutomationOpen['intent']
): BotAutomationOpen {
  const hostId = owner ? getRuntimeTargetHostId(owner.target) : null
  return {
    owner:
      owner && 'automationOwner' in owner
        ? owner.automationOwner
        : owner?.target.kind === 'local'
          ? { authority: { kind: 'desktop' }, selector: { kind: 'self' } }
          : null,
    bot: automation.bot && hostId ? { hostId, id: automation.bot.botId } : null,
    automationId: automation.id,
    runId,
    hostId,
    ...(intent ? { intent } : {})
  }
}
