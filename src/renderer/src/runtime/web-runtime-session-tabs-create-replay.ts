import { createBrowserUuid } from '@/lib/browser-uuid'
import { TERMINAL_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { RuntimeMobileSessionCreateTerminalResult } from '../../../shared/runtime-types'
import { isRemoteCreateOutcomeUnknown } from './remote-create-outcome'
import { runtimeEnvironmentSupportsCapability, unwrapRuntimeRpcResult } from './runtime-rpc-client'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import type { captureRuntimeEnvironmentCall } from './web-runtime-session-environment'
import type { CreateWebRuntimeSessionTerminalArgs } from './web-runtime-session-types'
import { toHostSessionTabId } from './web-terminal-surface-id'

export function createSessionTabsTerminalWithReplay(
  environmentId: string,
  callEnvironment: ReturnType<typeof captureRuntimeEnvironmentCall>,
  args: CreateWebRuntimeSessionTerminalArgs,
  waitToReplay?: () => Promise<boolean>
): Promise<RuntimeMobileSessionCreateTerminalResult> {
  return runSessionTabsCreateWithReplay(environmentId, waitToReplay, async (clientMutationId) => {
    const response = await callEnvironment({
      method: 'session.tabs.createTerminal',
      params: {
        worktree: toRuntimeWorktreeSelector(args.worktreeId),
        afterTabId: args.afterTabId ? toHostSessionTabId(args.afterTabId) : undefined,
        targetGroupId: args.targetGroupId,
        command: args.command,
        cwd: args.cwd,
        ...(args.env ? { env: args.env } : {}),
        ...(args.envToDelete ? { envToDelete: args.envToDelete } : {}),
        startupCommandDelivery: args.startupCommandDelivery,
        ...(args.launchConfig ? { launchConfig: args.launchConfig } : {}),
        ...(args.launchToken ? { launchToken: args.launchToken } : {}),
        ...(args.agent ? { agent: args.agent } : {}),
        ...(args.launchAgent ? { launchAgent: args.launchAgent } : {}),
        ...(args.viewMode ? { viewMode: args.viewMode } : {}),
        // Why: old hosts understand activate:false; new hosts use select/navigation for caller-local focus.
        activate: false,
        select: args.activate !== false,
        navigation: 'caller',
        clientMutationId
      },
      timeoutMs: 15_000
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every supported host answers this method with RuntimeMobileSessionCreateTerminalResult.
    const created = response as RuntimeRpcResponse<RuntimeMobileSessionCreateTerminalResult>
    return unwrapRuntimeRpcResult(created)
  })
}

/**
 * Runs a `session.tabs.createTerminal` call and, when its reply was lost, replays it once under the
 * same `clientMutationId` so the host returns the terminal it already made instead of a second one.
 */
export async function runSessionTabsCreateWithReplay<TResult>(
  environmentId: string,
  waitToReplay: (() => Promise<boolean>) | undefined,
  invoke: (clientMutationId: string) => Promise<TResult>
): Promise<TResult> {
  // Why always sent: hosts without the dedupe strip the unknown key, as for mobile creates.
  const clientMutationId = createBrowserUuid()
  try {
    return await invoke(clientMutationId)
  } catch (error) {
    if (!isRemoteCreateOutcomeUnknown(error) || !(await hostDedupesCreates(environmentId))) {
      throw error
    }
  }
  try {
    return await invoke(clientMutationId)
  } catch (error) {
    // Why: as for agent creates, a replay that met a still-down network gets one more after reconnect.
    if (!isRemoteCreateOutcomeUnknown(error) || !waitToReplay || !(await waitToReplay())) {
      throw error
    }
    return await invoke(clientMutationId)
  }
}

async function hostDedupesCreates(environmentId: string): Promise<boolean> {
  try {
    // Why this capability: session.tabs.createTerminal deduped by clientMutationId before any host
    // advertised it, and no capability names that older dedupe directly.
    return await runtimeEnvironmentSupportsCapability(
      environmentId,
      TERMINAL_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY
    )
  } catch {
    return false
  }
}
