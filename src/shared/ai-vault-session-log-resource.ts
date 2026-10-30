import type { AiVaultAgent, AiVaultSession } from './ai-vault-types'
import { getRuntimePathBasename } from './cross-platform-path'

export function clineMessagesPathForMetadata(filePath: string): string {
  return filePath.endsWith('.json') ? `${filePath.slice(0, -'.json'.length)}.messages.json` : ''
}

export function kiroTranscriptPathForMetadata(filePath: string): string {
  return filePath.endsWith('.json') ? `${filePath}l` : ''
}

export function grokTranscriptPathForMetadata(filePath: string): string {
  return replaceSessionFileName(filePath, 'chat_history.jsonl')
}

export function rovoTranscriptPathForMetadata(filePath: string): string {
  return replaceSessionFileName(filePath, 'session_context.json')
}

function replaceSessionFileName(filePath: string, fileName: string): string {
  const basename = getRuntimePathBasename(filePath)
  return `${filePath.slice(0, -basename.length)}${fileName}`
}

type LogFileResolver = (filePath: string) => string | null

const jsonlLog: LogFileResolver = (filePath) => (/\.jsonl$/i.test(filePath) ? filePath : null)
const jsonLog: LogFileResolver = (filePath) => (/\.json$/i.test(filePath) ? filePath : null)

// Storage locators may name metadata or a shared database, rather than one conversation's log.
const logFileResolvers = {
  claude: jsonlLog,
  codebuddy: jsonlLog,
  qoder: jsonlLog,
  codex: jsonlLog,
  hermes: jsonLog,
  pi: jsonlLog,
  omp: jsonlLog,
  'prime-agent': jsonlLog,
  cursor: jsonlLog,
  gemini: (filePath) => jsonLog(filePath) ?? jsonlLog(filePath),
  antigravity: jsonlLog,
  rovo: (filePath) =>
    getRuntimePathBasename(filePath) === 'metadata.json'
      ? rovoTranscriptPathForMetadata(filePath)
      : null,
  copilot: jsonlLog,
  opencode: () => null,
  opencode2: () => null,
  zcode: () => null,
  grok: (filePath) =>
    getRuntimePathBasename(filePath) === 'summary.json'
      ? grokTranscriptPathForMetadata(filePath)
      : null,
  openclaw: jsonlLog,
  devin: jsonLog,
  droid: jsonlLog,
  cline: (filePath) => clineMessagesPathForMetadata(filePath) || null,
  // The primary wire path requires state contents unavailable in a History row.
  kimi: () => null,
  muse: jsonlLog,
  jcode: jsonLog,
  kiro: (filePath) => kiroTranscriptPathForMetadata(filePath) || null
} satisfies Record<AiVaultAgent, LogFileResolver>

export function aiVaultSessionLogFilePath(
  session: Pick<AiVaultSession, 'agent' | 'filePath'>
): string | null {
  const filePath = session.filePath.trim()
  return filePath ? logFileResolvers[session.agent](filePath) : null
}
