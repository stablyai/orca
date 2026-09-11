import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { track, tuiAgentToAgentKind } from '@/lib/telemetry'
import type { TuiAgent } from '../../../shared/tui-agent'

/**
 * User-facing half of the renderer credential-prompt refusal. Refusing the write is only half
 * the fix: a prompt that vanishes with no notice is the silent-drop bug wearing a guard's coat.
 *
 * Why this existing string: a live sign-in dialog IS the agent not being ready, and the advice
 * — paste it yourself once it is — is unchanged, so all five locales stay correct.
 */
export function showAgentPasteCredentialPromptToast(agent: TuiAgent, submitted: boolean): void {
  toast.message(
    translate(
      'auto.lib.launch.agent.in.new.tab.a5a1f7033f',
      "Your {{value0}} wasn't sent — paste it once the agent is ready.",
      { value0: submitted ? 'prompt' : 'notes' }
    )
  )
  // Why 'unknown': errorClassSchema has no credential-refusal slot, and the dashboard's unknown
  // slice is this repo's established trigger to add one.
  track('agent_error', { error_class: 'unknown', agent_kind: tuiAgentToAgentKind(agent) })
}
