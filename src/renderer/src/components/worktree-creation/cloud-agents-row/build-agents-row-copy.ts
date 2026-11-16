import type { Translate } from '@/i18n/use-translate'
import { getIntlLocale } from '@/i18n/i18n'
import type { OrcaCloudAccountAgent } from '../../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import { agentName } from '../../settings/agent-accounts/orca-cloud-accounts-copy'

/** "Claude and Codex" in the user's language (Intl.ListFormat, never concatenation). */
export function agentList(agents: readonly OrcaCloudAccountAgent[], t: Translate): string {
  const names = agents.map((agent) => agentName(agent, t))
  try {
    return new Intl.ListFormat(getIntlLocale(), { style: 'long', type: 'conjunction' }).format(
      names
    )
  } catch {
    return names.join(', ')
  }
}
