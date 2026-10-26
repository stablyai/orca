import { createWebRuntimeAgentTerminalAuthority } from './web-runtime-agent-terminal-authority'
import { createAgentTerminalResumeAttemptRegistry } from '../../../shared/agent-terminal-resume-attempt'
import { createAgentSessionOperationId } from './agent-session-operation-id'
import { AGENT_RESUME_HOST_PLAN_CAPABILITY } from '../../../shared/agent-terminal-resume'
import { prepareLegacyAgentTerminalResume } from '@/lib/legacy-agent-terminal-resume'
import { buildDefaultTerminalOptions } from '@/lib/pane-manager/pane-terminal-options'
import { createAgentSessionKeyboardOptions } from './agent-session-keyboard-capability'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { RuntimeMobileSessionCreateTerminalResult } from '../../../shared/runtime-types'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import { translate } from '../i18n/i18n'
import { useAppStore } from '../store'
import { agentResumeHostAuthorityCapability } from './agent-resume-host-authority-capability'
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
import { createdTerminalLeafId } from './web-runtime-terminal-identity'
import { settleWebRuntimeTerminalPlacement } from './web-runtime-terminal-placement-settlement'
import { buildPlainCreateTerminalParams } from './web-runtime-plain-terminal-create-params'

type WebAgentTerminalResult = {
  terminal: CreatedAgentTerminalIdentity
  placedInGroup?: true
}
type WebResumeAttempt = {
  args: CreateWebRuntimeSessionTerminalArgs
  run?: () => Promise<WebAgentTerminalResult>
}
const resumeAttempts = createAgentTerminalResumeAttemptRegistry<WebResumeAttempt>(
  createAgentSessionOperationId
)

export async function createWebRuntimeSessionTerminalResult(
  requested: CreateWebRuntimeSessionTerminalArgs
): Promise<CreatedWebRuntimeSessionTerminal> {
  const environmentId = resolveWebRuntimeSessionEnvironmentId(
    requested.environmentId,
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
  const attemptKey =
    requested.resume && requested.providerSession
      ? JSON.stringify([
          environmentId,
          requested.worktreeId,
          requested.launchAgent ?? requested.agent,
          requested.providerSession.key,
          requested.providerSession.id,
          requested.providerSession.transcriptPath
        ])
      : undefined
  const frozen = attemptKey ? resumeAttempts.freeze(attemptKey, { args: requested }) : undefined
  const resumeAttempt = frozen?.attempt
  const args = resumeAttempt?.args ?? requested
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
      let legacyResume: ReturnType<typeof prepareLegacyAgentTerminalResume> | undefined
      const prepareLegacy = () =>
        args.resume
          ? (legacyResume ??= prepareLegacyAgentTerminalResume({
              worktreeId: args.worktreeId,
              agent,
              providerSession: args.providerSession,
              resume: args.resume,
              cwd: args.cwd
            }))
          : args
      const createHostAuthority = createWebRuntimeAgentTerminalAuthority(
        {
          args,
          agent,
          agentArgsOverride,
          environmentId,
          callEnvironment,
          keyboardOptions
        },
        () => prepareLegacy().launchConfig
      )
      const hostAuthority = createHostAuthority(args.resume)
      const legacyCreate = async () => {
        if (resumeAttempt) {
          resumeAttempt.run = legacyCreate
        }
        const legacy = prepareLegacy()
        const response = await callEnvironment({
          method: 'session.tabs.createTerminal',
          params: {
            worktree: toRuntimeWorktreeSelector(args.worktreeId),
            ...(frozen ? { clientMutationId: frozen.clientMutationId } : {}),
            afterTabId: args.afterTabId ? toHostSessionTabId(args.afterTabId) : undefined,
            targetGroupId: args.targetGroupId,
            command: legacy.command,
            cwd: args.cwd,
            ...(legacy.env || args.env ? { env: { ...legacy.env, ...args.env } } : {}),
            ...(args.envToDelete ? { envToDelete: args.envToDelete } : {}),
            startupCommandDelivery: legacy.startupCommandDelivery,
            ...(legacy.launchConfig ? { launchConfig: legacy.launchConfig } : {}),
            ...(args.launchToken ? { launchToken: args.launchToken } : {}),
            ...(args.providerSession ? { resumeProviderSession: args.providerSession } : {}),
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
        return {
          placedInGroup: true as const,
          terminal: {
            tabId: legacyCreated.tab.id,
            leafId: legacyCreated.tab.leafId
          }
        }
      }
      const selectHostAuthority = (run: ReturnType<typeof createHostAuthority>) =>
        run
          ? () => {
              if (resumeAttempt) {
                resumeAttempt.run = run
              }
              return run()
            }
          : undefined
      const legacyLaunch = () =>
        runRemoteAgentSessionLaunch<WebAgentTerminalResult>({
          environmentId,
          ...(args.preparedAgentCommand || args.afterTabId
            ? {}
            : { hostAuthority: selectHostAuthority(createHostAuthority(null)) }),
          ...(args.agentSessionKind === 'resume'
            ? { hostAuthorityCapability: agentResumeHostAuthorityCapability(agent) }
            : {}),
          legacy: legacyCreate
        })
      const created = resumeAttempt?.run
        ? await resumeAttempt.run()
        : args.resume
          ? await runRemoteAgentSessionLaunch<WebAgentTerminalResult>({
              environmentId,
              ...(hostAuthority ? { hostAuthority: selectHostAuthority(hostAuthority) } : {}),
              hostAuthorityCapability: AGENT_RESUME_HOST_PLAN_CAPABILITY,
              legacy: legacyLaunch
            })
          : await legacyLaunch()
      if (attemptKey) {
        resumeAttempts.releaseOnSuccess(attemptKey)
      }
      const legacyAlreadyPlacedInGroup = created.placedInGroup === true
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
