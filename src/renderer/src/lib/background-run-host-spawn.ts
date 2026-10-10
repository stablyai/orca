/**
 * Spawns a desktop automation's agent through this window's host (`agent.launch` with a
 * `backgroundRun`), which builds and spawns exactly the launch this window would. The window still
 * adopts the hidden tab, observes the run and pastes a post-start prompt, as on main.
 *
 * Temporary gates (launch-unification phase 2) keep the window's own spawn for an SSH workspace and
 * for a launch planned for another platform than this machine's (a WSL path). A host that refused
 * before spawning gets the same: the run starts as main starts it.
 */

import { callRuntimeRpc, RuntimeRpcCallError } from '@/runtime/runtime-rpc-client'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { isAgentLaunchResult } from '../../../shared/agent-launch-intent'
import {
  AGENT_LAUNCH_BACKGROUND_RUN_SPAWN_FAILED_CODE,
  AGENT_LAUNCH_BACKGROUND_RUN_UNAVAILABLE_CODE
} from '../../../shared/agent-launch-background-run'
import { makePaneKey } from '../../../shared/stable-pane-id'
import type { LaunchSource } from '../../../shared/telemetry-events'
import type { TuiAgent } from '../../../shared/tui-agent'

type WindowPtySpawnArgs = Parameters<typeof window.api.pty.spawn>[0]
type WindowPtySpawnResult = Awaited<ReturnType<typeof window.api.pty.spawn>>

export type BackgroundRunSpawnArgs = {
  /** The window's own spawn, made as is wherever the host does not start the run. */
  spawn: WindowPtySpawnArgs & { tabId: string; leafId: string; launchToken: string }
  agent: TuiAgent
  worktreeId: string
  /** Only an argv agent's prompt: it rides the launch command, which the host builds. */
  commandPrompt?: string
  extraAgentArgs?: string
  title?: string
  launchSource?: LaunchSource
  launchPlatform: NodeJS.Platform
}

export async function spawnBackgroundRunPty(
  args: BackgroundRunSpawnArgs
): Promise<Pick<WindowPtySpawnResult, 'id' | 'incarnationId' | 'launchConfig'>> {
  const { spawn } = args
  if (spawn.connectionId || args.launchPlatform !== CLIENT_PLATFORM) {
    return window.api.pty.spawn(spawn)
  }
  let result: unknown
  try {
    result = await callRuntimeRpc<unknown>({ kind: 'local' }, 'agent.launch', {
      agent: args.agent,
      target: { kind: 'existing', worktree: `id:${args.worktreeId}` },
      ...(args.commandPrompt ? { prompt: { text: args.commandPrompt, delivery: 'submit' } } : {}),
      ...(args.launchSource ? { launchSource: args.launchSource } : {}),
      paneKey: makePaneKey(spawn.tabId, spawn.leafId),
      presentation: 'background',
      backgroundRun: {
        ...(args.title ? { title: args.title } : {}),
        ...(args.extraAgentArgs ? { extraAgentArgs: args.extraAgentArgs } : {}),
        launchToken: spawn.launchToken
      }
    })
  } catch (error) {
    const code = error instanceof RuntimeRpcCallError ? error.code : undefined
    if (code === AGENT_LAUNCH_BACKGROUND_RUN_UNAVAILABLE_CODE) {
      return window.api.pty.spawn(spawn)
    }
    if (code === AGENT_LAUNCH_BACKGROUND_RUN_SPAWN_FAILED_CODE && error instanceof Error) {
      // The run records the failure in the words main's own spawn failed with.
      throw new Error(`Error invoking remote method 'pty:spawn': ${error.message}`)
    }
    throw error
  }
  const spawned = isAgentLaunchResult(result) ? result.backgroundRun : undefined
  if (!spawned || typeof spawned.ptyId !== 'string') {
    throw new Error('The agent launch did not report its terminal.')
  }
  return {
    id: spawned.ptyId,
    ...(spawned.incarnationId ? { incarnationId: spawned.incarnationId } : {}),
    ...(spawned.launchConfig ? { launchConfig: spawned.launchConfig } : {})
  }
}
