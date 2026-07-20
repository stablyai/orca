import { callRuntimeRpc, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import type { RuntimeTerminalCreate } from '../../../shared/runtime-types'
import type { WorktreeSetupLaunch } from '../../../shared/types'

export async function launchRuntimeWorktreeSetupTerminal(args: {
  runtimeTarget: Extract<RuntimeClientTarget, { kind: 'environment' }>
  worktreeId: string
  setup: WorktreeSetupLaunch
  command: string
  title: string
}): Promise<void> {
  await callRuntimeRpc<{ terminal: RuntimeTerminalCreate }>(
    args.runtimeTarget,
    'terminal.create',
    {
      worktree: toRuntimeWorktreeSelector(args.worktreeId),
      command: args.command,
      env: args.setup.envVars,
      title: args.title,
      presentation: 'background'
    },
    { timeoutMs: 15_000 }
  )
}
