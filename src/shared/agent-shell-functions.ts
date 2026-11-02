import { getFishClaudeShellFunction, getPosixClaudeShellFunction } from './claude-shell-function'
import {
  getFishCodexShellLaunchPreflight,
  getPosixCodexShellLaunchPreflight
} from './codex-shell-function'
import {
  fishSavedRestoreCheck,
  fishSavedRestoreProofLines,
  posixSavedRestoreProofLines
} from './saved-restore-dispatch'

// Agents with no argument or config handling of their own get a function only so a saved restore
// can check its conversation where the invocation runs; every other call passes straight through.
// Claude has its own function only in account panes, so other panes get the pass-through.
const PASS_THROUGH_AGENTS: { agent: string; unlessSet?: string }[] = [
  { agent: 'claude', unlessSet: 'ORCA_CLAUDE_PROFILE_POINTER' },
  { agent: 'opencode' },
  { agent: 'opencode2' }
]

function posixPassThrough({ agent, unlessSet }: (typeof PASS_THROUGH_AGENTS)[number]): string {
  return `__orca_agent_binary="$(unalias ${agent} 2>/dev/null || :; command -v ${agent} 2>/dev/null || :)"
# Why /*: only a binary found on PATH gets a function; the user's own function keeps the name.
case "$__orca_agent_binary" in
  /*) if [ -x "$__orca_agent_binary" ]${unlessSet ? ` && [ -z "\${${unlessSet}:-}" ]` : ''}; then
    function ${agent} {
      ${posixSavedRestoreProofLines('__orca_agent_proof')}
      __orca_saved_restore_exec ${agent} "$__orca_agent_proof" "$@"
    }
  fi ;;
esac
unset __orca_agent_binary
`
}

function fishPassThrough({ agent, unlessSet }: (typeof PASS_THROUGH_AGENTS)[number]): string {
  return `
set -l __orca_agent_type (type -t ${agent} 2>/dev/null)
if test "$__orca_agent_type" = file; and string match -q -- '/*' (command -s ${agent})${unlessSet ? `; and test -z "$${unlessSet}"` : ''}
  function ${agent}
    ${fishSavedRestoreProofLines()}
    ${fishSavedRestoreCheck(agent)}
    command ${agent} $argv
  end
end
set -e __orca_agent_type`
}

/** bash/zsh: every Orca agent function; each agent's own text defines the restore helpers it calls. */
export function getPosixAgentShellFunctions(): string {
  return (
    getPosixCodexShellLaunchPreflight() +
    getPosixClaudeShellFunction() +
    PASS_THROUGH_AGENTS.map(posixPassThrough).join('')
  )
}

export function getFishAgentShellFunctions(): string {
  return (
    getFishCodexShellLaunchPreflight() +
    getFishClaudeShellFunction() +
    PASS_THROUGH_AGENTS.map(fishPassThrough).join('')
  )
}
