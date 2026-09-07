import { agentArgOptionTokens } from './agent-session-option-agent-args'

/** Matches an exact token, the `flag=value` form, and clustered single-dash flags (`-mopus`). */
export function hasFlag(tokens: readonly string[], flags: readonly string[]): boolean {
  return agentArgOptionTokens(tokens).some((token) =>
    flags.some(
      (flag) =>
        token === flag ||
        token.startsWith(`${flag}=`) ||
        (flag.startsWith('-') && !flag.startsWith('--') && token.startsWith(flag))
    )
  )
}
