import type { AgentJournalSkillRef } from '../agent-session/journal/agent-session-journal-types'
import {
  pickedSkillsInText,
  SkillRefLimitError
} from '../agent-session/requests/structured-agent-session-send-mutation'
import { getNativeChatAgentProfile } from '../native-chat/input/commands/native-chat-agent-profiles'
import { MAX_SKILL_REFS } from '../rpc-contract/structured-agent-session/structured-agent-session-message-params'
import type { BotItemCommentSkill } from './bot-items'

/** A comment's picked skills as a chat message carries them: those its text still names, each once.
 *  More than a message may carry throws SkillRefLimitError, as chat's send does. */
export function sentBotItemCommentSkills(
  text: string,
  picked: readonly AgentJournalSkillRef[],
  agent: Parameters<typeof getNativeChatAgentProfile>[0]
): BotItemCommentSkill[] {
  const skills = pickedSkillsInText(text, picked, [
    getNativeChatAgentProfile(agent)?.skillPrefix ?? '/'
  ])
  if (skills.length > MAX_SKILL_REFS) {
    throw new SkillRefLimitError()
  }
  return skills
}
