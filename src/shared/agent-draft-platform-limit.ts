const WIN32_INLINE_DRAFT_LIMIT_CHARS = 24_000

export function inlineAgentDraftFitsPlatform(args: {
  command: string
  env?: Record<string, string>
  platform: NodeJS.Platform
}): boolean {
  if (args.platform !== 'win32') {
    return true
  }
  const envChars = Object.entries(args.env ?? {}).reduce(
    (total, [key, value]) => total + key.length + value.length,
    0
  )
  // Why: Windows CreateProcess/env blocks have tight length ceilings. Large
  // generated drafts should use the existing post-ready paste fallback.
  return args.command.length + envChars <= WIN32_INLINE_DRAFT_LIMIT_CHARS
}
