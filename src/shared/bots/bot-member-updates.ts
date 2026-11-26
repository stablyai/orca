import { withoutBotMember, type BotMember } from '../bot-types'
import type { BotUpdateParams } from '../rpc-contract/bots-params'
import { botMembersFullError, planBotMemberAdds } from './bot-member-capacity'

/** Who can ask after the people an update takes off and adds, applied to the list the host has now.
 *  Throws botMembersFullError, saving nothing, when an add would pass a limit. */
export function applyBotMemberUpdates(
  members: readonly BotMember[],
  updates: Pick<BotUpdateParams['updates'], 'removeMember' | 'removeMembers' | 'addMembers'>
): BotMember[] {
  const { removeMember, removeMembers = [], addMembers = [] } = updates
  let next = [...members]
  for (const key of [...(removeMember ? [removeMember] : []), ...removeMembers]) {
    next = withoutBotMember(next, key)
  }
  const plan = planBotMemberAdds(next, addMembers)
  if (!plan.ok) {
    throw botMembersFullError(plan.full)
  }
  return plan.members
}
