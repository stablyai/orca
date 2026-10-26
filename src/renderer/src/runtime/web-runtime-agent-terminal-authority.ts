import type { SleepingAgentLaunchConfig } from '../../../shared/agent-session-resume'
import type { TuiAgent } from '../../../shared/tui-agent'
import { agentProviderSessionForHostEnsure } from './agent-session-ensure-provider-session'
import {
  createAgentSessionCreateOperation,
  withAgentSessionCreateOperationId
} from './agent-session-create-operation'
import { unwrapRuntimeRpcResult } from './runtime-rpc-result'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import { readCreatedAgentTerminalIdentity } from './web-runtime-terminal-identity'
import type { CreateWebRuntimeSessionTerminalArgs } from './web-runtime-session-types'
import type { captureRuntimeEnvironmentCall } from './web-runtime-session-environment'
import type { createAgentSessionKeyboardOptions } from './agent-session-keyboard-capability'

export function createWebRuntimeAgentTerminalAuthority(
  {
    args,
    agent,
    agentArgsOverride,
    environmentId,
    callEnvironment,
    keyboardOptions
  }: {
    args: CreateWebRuntimeSessionTerminalArgs
    agent: TuiAgent
    agentArgsOverride: string | null | undefined
    environmentId: string
    callEnvironment: ReturnType<typeof captureRuntimeEnvironmentCall>
    keyboardOptions: ReturnType<typeof createAgentSessionKeyboardOptions>
  },
  legacyLaunchConfig: () => SleepingAgentLaunchConfig | undefined
) {
  let legacyProviderSession: Promise<NonNullable<typeof args.providerSession>> | undefined
  const mustUseLegacyAgentCreate = !args.resume && (args.preparedAgentCommand || args.afterTabId)
  return (typedResume: typeof args.resume | null) =>
    mustUseLegacyAgentCreate
      ? undefined
      : args.agentSessionKind === 'resume'
        ? args.providerSession
          ? async () => {
              const config = args.launchConfig
              const ensureArgs =
                agentArgsOverride !== undefined
                  ? agentArgsOverride
                  : !typedResume &&
                      args.resume &&
                      (args.resume.recipe.source === 'current-inputs' ||
                        (args.resume.recipe.source === 'saved' && args.resume.recipe.launchConfig))
                    ? legacyLaunchConfig()?.agentArgs
                    : config?.agentArgs
              const ompResumeFilePath = args.resume?.ompResumeFilePath ?? config?.ompResumeFilePath
              return readCreatedAgentTerminalIdentity(
                unwrapRuntimeRpcResult(
                  await callEnvironment({
                    method: 'terminal.ensureAgentSession',
                    params: {
                      ...(await keyboardOptions(environmentId)),
                      kind: 'explicit',
                      ...(typedResume
                        ? {
                            resume: structuredClone(typedResume),
                            ...(args.env ? { env: args.env } : {}),
                            ...(args.envToDelete ? { envToDelete: args.envToDelete } : {}),
                            ...(args.cwd ? { cwd: args.cwd } : {})
                          }
                        : {}),
                      worktree: toRuntimeWorktreeSelector(args.worktreeId),
                      agent,
                      providerSession: typedResume
                        ? args.providerSession!
                        : await (legacyProviderSession ??= agentProviderSessionForHostEnsure(
                            environmentId,
                            args.providerSession!
                          )),
                      ...(ompResumeFilePath ? { ompResumeFilePath } : {}),
                      ...(ensureArgs !== undefined ? { agentArgs: ensureArgs } : {}),
                      ...(args.launchPreferences
                        ? { launchPreferences: args.launchPreferences }
                        : {}),
                      presentation: 'background'
                    },
                    timeoutMs: 15_000
                  })
                )
              )
            }
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
}
