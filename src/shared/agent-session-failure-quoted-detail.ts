import type { ProviderDiagnostic } from './agent-session-failure'
import type {
  AgentSessionFailureCopyId,
  AgentSessionFailureCopyValues,
  AgentSessionFailureSay
} from './agent-session-failure-copy'

/** Person-facing provider text is quoted, but bounded so the sentence stays one. */
const MAX_QUOTED_DETAIL_CHARS = 512

/** The quoted lead when the provider wrote the detail for a person; the plain lead otherwise. */
export function quotingPersonDetail(
  say: AgentSessionFailureSay,
  lead: AgentSessionFailureCopyId,
  quotedLead: AgentSessionFailureCopyId,
  detail: ProviderDiagnostic | undefined,
  values: AgentSessionFailureCopyValues = {}
): string {
  const quoted =
    detail?.audience === 'person'
      ? detail.text
          .slice(0, MAX_QUOTED_DETAIL_CHARS)
          .trim()
          .replace(/[.\s]+$/, '')
      : ''
  return quoted ? say(quotedLead, { ...values, detail: quoted }) : say(lead, values)
}
