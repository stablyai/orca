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
  // Windows argv/env ceilings require large drafts to use post-ready paste.
  return args.command.length + envChars <= WIN32_INLINE_DRAFT_LIMIT_CHARS
}
