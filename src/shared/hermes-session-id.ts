const TIMESTAMP_SESSION_ID = /^\d{8}_\d{6}_[0-9a-f]+$/i
const UUID_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Hermes persists timestamp ids and ACP uuids. Titles and `latest` are not resume targets. */
export function hermesResumeSessionId(value: string | null | undefined): string | null {
  const target = value?.trim() ?? ''
  if (!TIMESTAMP_SESSION_ID.test(target) && !UUID_SESSION_ID.test(target)) {
    return null
  }
  return target
}

/** ACP `session/load` restores only `source: acp` uuids. A TUI timestamp comes back empty. */
export function hermesAcpLoadSessionId(
  agent: string,
  resumeFrom: { providerSessionId: string } | undefined
): string | null {
  if (agent !== 'hermes') {
    return null
  }
  const target = resumeFrom?.providerSessionId.trim() ?? ''
  return UUID_SESSION_ID.test(target) ? target : null
}

/** A Hermes resume with neither a transcript importer nor an ACP uuid cannot attach. */
export function hermesLoadAttach(
  agent: string,
  resumeFrom: { providerSessionId: string } | undefined,
  transcriptImport: unknown
): {
  unsupported: boolean
  fields: { acpLoadSessionId: string } | Record<string, never>
  apply: <T extends object>(replay: T) => T
} {
  const acpLoadSessionId = hermesAcpLoadSessionId(agent, resumeFrom)
  return {
    unsupported: Boolean(resumeFrom && !transcriptImport && !acpLoadSessionId),
    fields: acpLoadSessionId ? { acpLoadSessionId } : {},
    apply: (replay) => (acpLoadSessionId ? { ...replay, acpLoadSessionId } : replay)
  }
}
