import {
  quoteStartupArg,
  type AgentStartupShell
} from './tui-agent-startup-shell'

// Why: Windows CreateProcess/env blocks have tight length ceilings. Large
// generated prompts/drafts should use the existing post-ready paste fallback.
export const WIN32_INLINE_DRAFT_LIMIT_CHARS = 24_000

export function normalizeStartupImagePaths(
  imagePaths: readonly string[] | null | undefined
): string[] {
  if (!imagePaths || imagePaths.length === 0) {
    return []
  }
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const raw of imagePaths) {
    const pathValue = raw.trim()
    if (!pathValue || seen.has(pathValue)) {
      continue
    }
    seen.add(pathValue)
    normalized.push(pathValue)
  }
  return normalized
}

/** Why: Codex accepts repeatable `-i/--image PATH` for startup image attachments. */
export function appendCodexImageArgs(
  command: string,
  imagePaths: readonly string[],
  shell: AgentStartupShell
): string {
  if (imagePaths.length === 0) {
    return command
  }
  const flags = imagePaths.map((pathValue) => `-i ${quoteStartupArg(pathValue, shell)}`).join(' ')
  return `${command} ${flags}`
}

export function inlineCommandFitsPlatform(
  launchCommand: string,
  env: Record<string, string> | undefined,
  platform: NodeJS.Platform
): boolean {
  if (platform !== 'win32') {
    return true
  }
  const envChars = Object.entries(env ?? {}).reduce(
    (total, [key, value]) => total + key.length + value.length,
    0
  )
  return launchCommand.length + envChars <= WIN32_INLINE_DRAFT_LIMIT_CHARS
}
