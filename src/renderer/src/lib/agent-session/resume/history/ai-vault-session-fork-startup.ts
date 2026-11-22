import { readManagedAgentCommandsForWorktree } from '@/lib/agent-session/launch/inventory/agent-detection-target-inventory'
import { useAppStore } from '@/store/index'
import {
  parseExecutionHostId,
  type ExecutionHostScope
} from '../../../../../../shared/execution-host/execution-host'
import {
  assertAiVaultCopiedSessionStoreAllowed,
  buildAiVaultForkStartup,
  buildAiVaultLocalResumeStartup,
  type AiVaultResumeLaunchSettings,
  type AiVaultResumeStartup
} from '../../../../../../shared/ai-vault/resume/ai-vault-resume-startup'
import {
  resolveAiVaultResumeHost,
  type AiVaultResumeWorktreeArgs
} from '@/lib/agent-session/resume/history/ai-vault-resume-command'
import { readHostAgentStartupSettings } from '@/runtime/agent-launch-settings/agent-launch-settings-transport'
import {
  captureWebSessionIntentOwner,
  matchesWebSessionIntentOwner
} from '@/runtime/web-session-tabs-sync/identity/web-runtime-session-environment'
import type { WebSessionIntentOwner } from '@/runtime/web-session-tabs-sync/identity/web-session-intent-owner'
import { translate } from '@/i18n/i18n'

type CliForkWorktreeArgs = Omit<AiVaultResumeWorktreeArgs, 'agentArgs' | 'commandOverride'>

export function captureAiVaultCliForkOwner(
  executionHostId: ExecutionHostScope | undefined
): WebSessionIntentOwner | null {
  const host = parseExecutionHostId(executionHostId)
  return host?.kind === 'runtime' ? captureWebSessionIntentOwner(host.environmentId) : null
}

export function conversationHostUnavailableError(): Error {
  return new Error(
    translate('auto.lib.nativeChatCliFork.hostUnavailable', 'The conversation host is unavailable.')
  )
}

/** Read before preparing: a paired host's copy must not be made for a handoff that would be refused. */
export async function readAiVaultCliForkLaunchSettings(args: {
  owner: WebSessionIntentOwner | null
  localSettings: AiVaultResumeLaunchSettings | null | undefined
  signal?: AbortSignal
}): Promise<AiVaultResumeLaunchSettings | null | undefined> {
  const { owner } = args
  if (!owner) {
    return args.localSettings
  }
  const hostSettings = await readHostAgentStartupSettings(owner, args.signal)
  if (!hostSettings || !matchesWebSessionIntentOwner(owner)) {
    throw conversationHostUnavailableError()
  }
  return hostSettings
}

export function buildAiVaultCliForkStartupForWorktree(
  args: CliForkWorktreeArgs & {
    copied: boolean
    owner: WebSessionIntentOwner | null
    settings: AiVaultResumeLaunchSettings | null | undefined
  }
): AiVaultResumeStartup | null {
  const { owner, session, settings } = args
  if (owner && !matchesWebSessionIntentOwner(owner)) {
    throw conversationHostUnavailableError()
  }
  const startupArgs = {
    session,
    host: resolveAiVaultResumeHost(args),
    settings,
    managedAgentCommands: readManagedAgentCommandsForWorktree(
      useAppStore.getState(),
      args.worktreeId
    )
  }
  if (args.copied) {
    assertAiVaultCopiedSessionLaunchAllowed(args)
    return {
      ...buildAiVaultLocalResumeStartup({ ...startupArgs, embedCwd: false }),
      agent: session.agent
    }
  }
  return buildAiVaultForkStartup(startupArgs)
}

/** Runtime hosts validate their own launch settings when making the copy. */
export function assertAiVaultCopiedSessionLaunchAllowed(args: CliForkWorktreeArgs): void {
  if (parseExecutionHostId(args.session.executionHostId)?.kind === 'runtime') {
    return
  }
  assertAiVaultCopiedSessionStoreAllowed({
    session: args.session,
    host: resolveAiVaultResumeHost(args),
    settings: args.state.settings
  })
}
