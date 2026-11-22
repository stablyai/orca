// What a chat says when its agent can't start on this host until the person changes something there.
import type { AgentSessionFailureCopyId } from './agent-session-failure-copy'
import { agent } from './agent-session-attachment-failure-words'
import type { Sentence } from './agent-session-failure-words'

export function namingAgent(id: AgentSessionFailureCopyId): Sentence {
  return (context, _fact, _surface, say) => say(id, agent(say, context))
}

export const SETUP_REFUSAL_SENTENCES = {
  managedAccountEnvOverride: (_context, _fact, _surface, say) => say('managedAccountEnvOverride'),
  accountSwitchInProgress: namingAgent('accountSwitchInProgress'),
  launchFolderMissing: (_context, _fact, _surface, say) => say('launchFolderMissing'),
  historyInOtherAccount: (_context, _fact, _surface, say) => say('historyInOtherAccount'),
  claudeAccountFolderMissing: (_context, _fact, _surface, say) => say('claudeAccountFolderMissing'),
  claudeAccountSetupFailed: (_context, _fact, _surface, say) => say('claudeAccountSetupFailed'),
  claudeAccountBindingUnavailable: namingAgent('claudeAccountBindingUnavailable'),
  runtimeNotInstalled: namingAgent('runtimeNotInstalled'),
  fullAccessAsRoot: namingAgent('fullAccessAsRoot'),
  botToolsNeedStatusHooks: namingAgent('botToolsNeedStatusHooks'),
  botToolsGatewayOutdated: namingAgent('botToolsGatewayOutdated'),
  conversationOpenInTerminal: namingAgent('conversationOpenInTerminal'),
  conversationOpenElsewhere: (_context, _fact, _surface, say) => say('conversationOpenElsewhere')
} satisfies Record<string, Sentence>
