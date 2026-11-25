export const AGENT_DOWNLOAD_START_TIMEOUT_MS = 10_000

// Counted from the request, so the reply beats the CLI's 60s timeout; the download keeps going after.
export const AGENT_DOWNLOAD_REPLY_DEADLINE_MS = 50_000
