import type { SetupRunPolicy } from './orca-yaml-hook-types'
import type { SetupDecision } from './worktree/create-types'

export function getAutomationSetupDefaultDecision(
  source: { setupRunPolicy: SetupRunPolicy } | null
): Extract<SetupDecision, 'run' | 'skip'> | undefined {
  if (!source) {
    return undefined
  }
  return source.setupRunPolicy === 'run-by-default' ? 'run' : 'skip'
}
