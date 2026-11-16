import type { AgentSessionFailureFact, ProviderDiagnostic } from './agent-session-failure'
import type {
  AgentSessionFailureCopyId,
  AgentSessionFailureCopyValues,
  AgentSessionFailureSay
} from './agent-session-failure-copy'

/** Person-facing provider text is quoted, but bounded so the sentence stays one. */
const MAX_QUOTED_DETAIL_CHARS = 512

/** Provider text as a failure sentence quotes it. */
export function quotedProviderDetail(text: string): string {
  return text
    .slice(0, MAX_QUOTED_DETAIL_CHARS)
    .trim()
    .replace(/[.\s]+$/, '')
}

/** The quoted lead when the provider wrote the detail for a person; the plain lead otherwise. */
export function quotingPersonDetail(
  say: AgentSessionFailureSay,
  lead: AgentSessionFailureCopyId,
  quotedLead: AgentSessionFailureCopyId,
  detail: ProviderDiagnostic | undefined,
  values: AgentSessionFailureCopyValues = {}
): string {
  const quoted = detail?.audience === 'person' ? quotedProviderDetail(detail.text) : ''
  return quoted ? say(quotedLead, { ...values, detail: quoted }) : say(lead, values)
}

/** The detail behind a failure's Details: provider words, or a log tail such as a CLI's startup stderr.
 *  A retry's log is the raw frame its row already shows. */
export function agentSessionFailureDetailText(
  fact: AgentSessionFailureFact | undefined
): string | undefined {
  const detail = fact?.detail
  return detail &&
    fact.kind !== 'pluginInputRequired' &&
    !(detail.audience === 'log' && fact.kind === 'providerRetrying')
    ? detail.text
    : undefined
}
