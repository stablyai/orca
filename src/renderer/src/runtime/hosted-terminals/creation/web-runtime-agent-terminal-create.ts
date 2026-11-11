import type {
  CreateWebRuntimeSessionTerminalOnHostArgs,
  CreatedAgentTerminalIdentity
} from './terminal-create-contracts'
import type { captureRuntimeEnvironmentCall } from '../../web-session-tabs-sync/identity/web-runtime-session-environment'
import { buildLegacyAgentCreateTerminalParams } from './web-runtime-legacy-agent-create-params'
import { buildDefaultTerminalOptions } from '@/lib/pane-manager/pane-terminal-options'
import { createAgentSessionKeyboardOptions } from './agent-launch/agent-session-keyboard-capability'
import type { RuntimeRpcResponse } from '../../../../../shared/runtime-rpc-envelope'
import { agentProviderSessionForHostEnsure } from './agent-launch/agent-session-ensure-provider-session'
import { agentResumeHostAuthorityCapability } from './agent-launch/agent-resume-host-authority-capability'
import { runRemoteAgentSessionLaunch } from './agent-launch/remote-agent-session-launch'
import { unwrapRuntimeRpcResult } from '../../rpc/calls/runtime-rpc-result'
import { toRuntimeWorktreeSelector } from '../../rpc/targets/runtime-worktree-selector'
import type { RuntimeMobileSessionCreateTerminalResult } from '../../../../../shared/runtime-session-contracts'
import { readCreatedAgentTerminalIdentity } from './web-runtime-terminal-identity'
import {
  createAgentSessionCreateOperation,
  withAgentSessionCreateOperationId
} from './agent-launch/agent-session-create-operation'
import {
  createAgentSessionTrustWorktreeOptions,
  agentSessionCreateRequest
} from './agent-launch/agent-session-create-request'

export function startWebRuntimeAgentTerminalCreate(
  args: CreateWebRuntimeSessionTerminalOnHostArgs,
  environmentId: string,
  callEnvironment: ReturnType<typeof captureRuntimeEnvironmentCall>,
  agent: NonNullable<CreateWebRuntimeSessionTerminalOnHostArgs['agent']>,
  agentArgsOverride: string | null | undefined
): {
  result: Promise<{ terminal: CreatedAgentTerminalIdentity }>
  wasLegacyPlacedInGroup: () => boolean
} {
  // Paired panes retain the default keyboard advertisement, including on Windows clients.
  const keyboardProtocol = buildDefaultTerminalOptions().vtExtensions?.kittyKeyboard
  const keyboardOptions = createAgentSessionKeyboardOptions(keyboardProtocol)
  const trustOptions = createAgentSessionTrustWorktreeOptions(args.trustWorktreeId)
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
                    providerSession: await agentProviderSessionForHostEnsure(
                      environmentId,
                      args.providerSession!
                    ),
                    ...(args.launchConfig?.ompResumeFilePath
                      ? { ompResumeFilePath: args.launchConfig.ompResumeFilePath }
                      : {}),
                    ...(agentArgsOverride !== undefined ? { agentArgs: agentArgsOverride } : {}),
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
                      ...(args.trustWorktreeId ? await trustOptions(environmentId) : {}),
                      ...agentSessionCreateRequest({
                        ...args,
                        agent,
                        agentArgs: args.agentArgs
                      }),
                      ...(args.cwd ? { startupCwd: args.cwd } : {}),
                      ...(args.viewMode ? { viewMode: args.viewMode } : {})
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
  const result = runRemoteAgentSessionLaunch<{
    terminal: CreatedAgentTerminalIdentity
  }>({
    environmentId,
    ...(hostAuthority ? { hostAuthority } : {}),
    ...((resumeHostAuthorityCapability ?? args.agentSessionCreateCapability)
      ? {
          hostAuthorityCapability:
            resumeHostAuthorityCapability ?? args.agentSessionCreateCapability
        }
      : {}),
    legacy: async () => {
      const legacyAgentLaunch = await args.legacyAgentLaunch?.()
      const response = await callEnvironment({
        method: 'session.tabs.createTerminal',
        params: buildLegacyAgentCreateTerminalParams(
          args,
          legacyAgentLaunch,
          args.trustWorktreeId ? await trustOptions(environmentId) : {}
        ),
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
  return { result, wasLegacyPlacedInGroup: () => legacyAlreadyPlacedInGroup }
}
