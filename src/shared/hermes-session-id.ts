const TIMESTAMP_SESSION_ID = /^\d{8}_\d{6}_[0-9a-f]+$/i
const UUID_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Hermes persists timestamp ids and ACP uuids. Titles and `latest` are not load targets. */
export function hermesResumeSessionId(value: string | null | undefined): string | null {
  const target = value?.trim() ?? ''
  if (!TIMESTAMP_SESSION_ID.test(target) && !UUID_SESSION_ID.test(target)) {
    return null
  }
  return target
}

/** Only Hermes can session/load a hook id. Other agents still need a transcript importer. */
export function hermesAcpLoadSessionId(
  agent: string,
  resumeFrom: { providerSessionId: string } | undefined
): string | null {
  if (agent !== 'hermes') {
    return null
  }
  return hermesResumeSessionId(resumeFrom?.providerSessionId)
}
