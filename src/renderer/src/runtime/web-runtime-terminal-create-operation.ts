import { buildDefaultTerminalOptions } from '@/lib/pane-manager/pane-terminal-options'
import { createAgentSessionKeyboardOptions } from './agent-session-keyboard-capability'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { RuntimeMobileSessionCreateTerminalResult } from '../../../shared/runtime-types'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import { agentProviderSessionForEnsure } from '../../../shared/agent-session-resume'
import { translate } from '../i18n/i18n'
import { useAppStore } from '../store'
import { agentResumeHostAuthorityCapability } from './agent-resume-host-authority-capability'
import {
  createAgentSessionCreateOperation,
  withAgentSessionCreateOperationId
} from './agent-session-create-operation'
import { runRemoteAgentSessionLaunch } from './remote-agent-session-launch'
import { unwrapRuntimeRpcResult } from './runtime-rpc-result'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import { resolveWebRuntimeSessionEnvironmentId } from './web-runtime-session-workspace-routing'
import { recordWebSessionFocusIntent } from './web-session-focus-intent'
import {
  forgetWebSessionTerminalPlacement,
  recordWebSessionTerminalPlacement,
  webTerminalPlacementParentTabId
} from './web-session-terminal-placement'
import { toHostSessionTabId } from '../../../shared/terminal-surface-id'
import {
  captureRuntimeEnvironmentCall,
  captureWebSessionIntentOwner,
  isWebRuntimeSessionActive,
  matchesWebSessionIntentOwner
} from './web-runtime-session-environment'
import { refreshWebRuntimeSessionTabsSnapshot } from './web-runtime-session-snapshot'
import type {
  CreatedAgentTerminalIdentity,
  CreatedWebRuntimeSessionTerminal,
  CreateWebRuntimeSessionTerminalArgs
} from './web-runtime-session-types'
import {
  readActiveWorkspaceSelection,
  restoreActiveWorkspaceSelection,
  selectWebRuntimeSessionWorktree,
  type WebRuntimeSessionWorkspaceSelectionRollback
} from './web-runtime-session-workspace-selection'
import {
  createdTerminalLeafId,
  readCreatedAgentTerminalIdentity
} from './web-runtime-terminal-identity'
import { settleWebRuntimeTerminalPlacement } from './web-runtime-terminal-placement-settlement'
import { buildPlainCreateTerminalParams } from './web-runtime-plain-terminal-create-params'

export async function createWebRuntimeSessionTerminalResult(
  args: CreateWebRuntimeSessionTerminalArgs
): Promise<CreatedWebRuntimeSessionTerminal> {
  const environmentId = resolveWebRuntimeSessionEnvironmentId(
    args.environmentId,
    useAppStore.getState().settings?.activeRuntimeEnvironmentId
  )
  if (!environmentId || !isWebRuntimeSessionActive(environmentId)) {
    return {
      outcome: {
        status: 'failed',
        message: translate(
          'auto.runtime.webRuntimeSession.remoteHostDisconnected',
          'The workspace is not connected to a remote Orca host.'
        )
      }
    }
  }
  const intentOwner = captureWebSessionIntentOwner(environmentId)
  const callEnvironment = captureRuntimeEnvironmentCall(environmentId, intentOwner.pairingRevision)

  let workspaceSelectionRollback: WebRuntimeSessionWorkspaceSelectionRollback | null = null
  if (args.selectWorktree !== false) {
    const previous = readActiveWorkspaceSelection()
    selectWebRuntimeSessionWorktree(args.worktreeId, environmentId)
    workspaceSelectionRollback = {
      previous,
      applied: {
        worktreeId: args.worktreeId,
        executionHostId: toRuntimeExecutionHostId(environmentId)
      }
    }
  }
  let hostCreated = false
  let createdTabId: string | undefined
  let createdLeafId: string | undefined
  try {
    const agent = args.launchAgent ?? args.agent
    const agentArgsOverride =
      args.agentArgs !== undefined ? args.agentArgs : args.launchConfig?.agentArgs
    if (agent) {
      // Paired panes retain the default keyboard advertisement, including on Windows clients.
      const keyboardProtocol = buildDefaultTerminalOptions().vtExtensions?.kittyKeyboard
      const keyboardOptions = createAgentSessionKeyboardOptions(keyboardProtocol)
      let legacyAlreadyPlacedInGroup = false
      // Keep legacy placement until structured creation supports afterTabId.
      // Focus belongs to this client; headless hosts have no renderer.
      // Rebuilding prepared commands under host authority can discard prompts/delivery flags.
      const mustUseLegacyAgentCreate = args.preparedAgentCommand || args.afterTabId
      const hostAuthority = mustUseLegacyAgentCreate
        ? undefined
        : args.agentSessionKind === 'resume'
          ? args.providerSession
            ? async () =>
                readCreatedAgentTerminalIdentity(
                  unwrapRuntimeRpcResult(
                    await callEnvironment({
                      method: 'terminal.ensureAgentSession',
                      params: {
                        ...(await keyboardOptions(environmentId)),
                        kind: 'explicit',
                        worktree: toRuntimeWorktreeSelector(args.worktreeId),
                        agent,
                        providerSession: agentProviderSessionForEnsure(args.providerSession!),
                        ...(args.launchConfig?.ompResumeFilePath
                          ? { ompResumeFilePath: args.launchConfig.ompResumeFilePath }
                          : {}),
                        ...(agentArgsOverride !== undefined
                          ? { agentArgs: agentArgsOverride }
                          : {}),
                        ...(args.launchPreferences
                          ? { launchPreferences: args.launchPreferences }
                          : {}),
                        presentation: 'background'
                      },
                      timeoutMs: 15_000
                    })
                  )
                )
            : undefined
          : async () =>
              await createAgentSessionCreateOperation().run(async (clientOperationId) =>
                readCreatedAgentTerminalIdentity(
                  unwrapRuntimeRpcResult(
                    await callEnvironment({
                      method: 'terminal.createAgentSession',
                      params: withAgentSessionCreateOperationId(
                        {
                          ...(await keyboardOptions(environmentId)),
                          worktree: toRuntimeWorktreeSelector(args.worktreeId),
                          agent,
                          ...(args.prompt ? { prompt: args.prompt } : {}),
                          ...(args.promptDelivery ? { promptDelivery: args.promptDelivery } : {}),
                          ...(agentArgsOverride !== undefined
                            ? { agentArgs: agentArgsOverride }
                            : {}),
                          ...(args.launchPreferences
                            ? { launchPreferences: args.launchPreferences }
                            : {}),
                          ...(args.cwd ? { startupCwd: args.cwd } : {}),
                          ...(args.viewMode ? { viewMode: args.viewMode } : {}),
                          presentation: 'background'
                        },
                        clientOperationId
                      ),
                      timeoutMs: 15_000
                    })
                  )
                )
              )
      const resumeHostAuthorityCapability =
        args.agentSessionKind === 'resume' ? agentResumeHostAuthorityCapability(agent) : undefined
      const created = await runRemoteAgentSessionLaunch<{
        terminal: CreatedAgentTerminalIdentity
      }>({
        environmentId,
        ...(hostAuthority ? { hostAuthority } : {}),
        ...(resumeHostAuthorityCapability
          ? { hostAuthorityCapability: resumeHostAuthorityCapability }
          : {}),
        legacy: async () => {
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
              // Old hosts use activate:false; new hosts use select/navigation for caller-local focus.
              activate: false,
              select: args.activate !== false,
              navigation: 'caller'
            },
            timeoutMs: 15_000
          })
          const legacyCreated = unwrapRuntimeRpcResult(
            response as RuntimeRpcResponse<RuntimeMobileSessionCreateTerminalResult>
          )
          legacyAlreadyPlacedInGroup = true
          return {
            terminal: {
              tabId: legacyCreated.tab.id,
              leafId: legacyCreated.tab.leafId
            }
          }
        }
      })
      hostCreated = true
      createdTabId = created.terminal.tabId
      createdLeafId = legacyAlreadyPlacedInGroup
        ? created.terminal.leafId
        : createdTerminalLeafId(created.terminal)
      if (args.targetGroupId && createdTabId && !legacyAlreadyPlacedInGroup) {
        await callEnvironment({
          method: 'session.tabs.move',
          params: {
            worktree: toRuntimeWorktreeSelector(args.worktreeId),
            tabId: createdTabId,
            targetGroupId: args.targetGroupId,
            kind: 'move-to-group'
          },
          timeoutMs: 15_000
        })
      }
    } else {
      const response = await callEnvironment({
        method: 'session.tabs.createTerminal',
        params: await buildPlainCreateTerminalParams(environmentId, args),
        timeoutMs: 15_000
      })
      const created = unwrapRuntimeRpcResult(
        response as RuntimeRpcResponse<RuntimeMobileSessionCreateTerminalResult>
      )
      hostCreated = true
      createdTabId = created.tab.id
      createdLeafId = created.tab.leafId
    }
    if (args.targetGroupId && createdTabId) {
      // Host drops client-minted group IDs; client placement must land the mirrored tab in the requested pane.
      recordWebSessionTerminalPlacement({
        environmentId,
        worktreeId: args.worktreeId,
        hostTabId: webTerminalPlacementParentTabId(createdTabId),
        groupId: args.targetGroupId
      })
    }
    if (args.activate !== false && createdTabId && matchesWebSessionIntentOwner(intentOwner)) {
      // Intent lets reconciliation focus this new terminal instead of sticky-keeping the previous tab.
      recordWebSessionFocusIntent(intentOwner, args.worktreeId, createdTabId, createdLeafId)
    }
    const placementTabId =
      createdTabId && (args.targetGroupId || args.afterTabId) ? createdTabId : undefined
    await refreshWebRuntimeSessionTabsSnapshot(environmentId, args.worktreeId, {
      expectedEnvironmentPairingRevision: intentOwner.pairingRevision,
      // Publication can beat RPC response; replay once caller intent exists.
      acceptCurrentSnapshot:
        Boolean(createdTabId) && (args.activate !== false || Boolean(placementTabId)),
      // Require a post-create list; deduped in-flight lists may predate placement.
      ...(placementTabId ? { afterCurrentInFlight: true } : {})
    })
    if (placementTabId) {
      await settleWebRuntimeTerminalPlacement(
        environmentId,
        args.worktreeId,
        webTerminalPlacementParentTabId(placementTabId),
        {
          groupId: args.targetGroupId,
          afterTabId: args.afterTabId,
          activate: args.activate !== false
        }
      )
    }
    return {
      outcome: { status: 'created' },
      ...(createdTabId ? { hostTabId: createdTabId } : {})
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(
      hostCreated
        ? '[web-runtime-session] terminal created but reconciliation failed:'
        : '[web-runtime-session] failed to create terminal:',
      message
    )
    if (createdTabId) {
      // Expire create placement or later user drags can be yanked back.
      forgetWebSessionTerminalPlacement({
        environmentId,
        worktreeId: args.worktreeId,
        hostTabId: webTerminalPlacementParentTabId(createdTabId)
      })
    }
    if (!hostCreated && workspaceSelectionRollback) {
      restoreActiveWorkspaceSelection(workspaceSelectionRollback)
    }
    // Accepted creation must not report failure and invite duplicate agent retries with new operation IDs.
    return {
      outcome: hostCreated ? { status: 'created' } : { status: 'failed', message },
      ...(createdTabId ? { hostTabId: createdTabId } : {}),
      ...(hostCreated ? {} : { hostFailed: true as const })
    }
  }
}
