// Codex writes these lifecycle types as JSON strings; message records need no decoding, token_count feeds context pressure.
const STATUS_RECORD_TYPE =
  /"(?:turn_context|thread_settings_applied|sub_agent_activity|task_started|turn_started|task_complete|turn_complete|turn_aborted|token_count)"/

export function isCodexStatusTranscriptLine(line: string): boolean {
  return STATUS_RECORD_TYPE.test(line)
}
