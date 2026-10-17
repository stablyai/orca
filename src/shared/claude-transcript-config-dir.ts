// Claude writes transcripts to `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<session>.jsonl`.
const CLAUDE_TRANSCRIPT_PATH = /^(\/.*)\/projects\/[^/]+\/[^/]+\.jsonl$/

/**
 * The config dir a Claude transcript was written under, when it is not the default `~/.claude`.
 * Only POSIX paths: the path comes from the host that ran Claude, so a WSL or SSH path stays valid
 * in that host's shell. Null for the default dir, because pinning CLAUDE_CONFIG_DIR to it moves
 * `.claude.json` and the keychain login.
 */
export function claudeConfigDirFromTranscriptPath(
  transcriptPath: string | undefined
): string | null {
  const configDir = transcriptPath?.match(CLAUDE_TRANSCRIPT_PATH)?.[1]
  if (!configDir || configDir.endsWith('/.claude')) {
    return null
  }
  return configDir
}
