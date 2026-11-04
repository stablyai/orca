// Decode lifecycle and quota snapshots; ordinary message/token-usage text stays out of the fold.
const STATUS_RECORD_TYPE =
  /"(?:turn_context|thread_settings_applied|sub_agent_activity|task_started|turn_started|task_complete|turn_complete|turn_aborted)"/

export function isCodexStatusTranscriptLine(line: string): boolean {
  return (
    STATUS_RECORD_TYPE.test(line) ||
    (line.includes('"token_count"') && /"rate_limits"\s*:\s*\{/.test(line))
  )
}

export function isCodexLifecycleTranscriptLine(line: string): boolean {
  return STATUS_RECORD_TYPE.test(line)
}
