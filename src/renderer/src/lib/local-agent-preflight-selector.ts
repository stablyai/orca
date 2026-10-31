import { shallow } from 'zustand/shallow'
import { createLocalProjectRuntimeWorkspaceSelector } from './local-project-runtime-workspace'
import {
  selectLocalAgentPreflightInput,
  resolveLocalAgentPreflightInput,
  type LocalPreflightContext
} from './local-preflight-context'
import { normalizeProjectExecutionRuntimeInput } from '../../../shared/project-execution-runtime'
import { hasCachedWindowsTerminalCapabilities } from './windows-terminal-capabilities'

/** One current selection per mounted target; inventory and action authority stay live. */
export function createLocalAgentPreflightSelector(worktreeId?: string | null) {
  const readWorkspace = createLocalProjectRuntimeWorkspaceSelector()
  let previous: ReturnType<typeof selectedFacts> | undefined
  let context: LocalPreflightContext
  return (state: Parameters<typeof selectLocalAgentPreflightInput>[0]): LocalPreflightContext => {
    const input = selectLocalAgentPreflightInput(
      state,
      undefined,
      undefined,
      worktreeId,
      readWorkspace
    )
    const facts = selectedFacts(input)
    if (!previous || !shallow(previous, facts)) {
      previous = facts
      context = resolveLocalAgentPreflightInput(input)
    }
    return context
  }
}

function selectedFacts(input: Parameters<typeof resolveLocalAgentPreflightInput>[0]) {
  if (typeof input !== 'object') {
    return { kind: 'primitive', value: input } as const
  }
  const normalized = normalizeProjectExecutionRuntimeInput(input)
  return {
    ...normalized,
    capabilityCachePresent:
      normalized.kind === 'wsl' && normalized.distro
        ? hasCachedWindowsTerminalCapabilities()
        : undefined
  }
}
