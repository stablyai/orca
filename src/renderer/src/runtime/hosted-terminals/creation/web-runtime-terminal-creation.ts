import { toast } from 'sonner'
import { createWebRuntimeSessionTerminalResult } from './web-runtime-terminal-create-operation'
import { resolveWebRuntimeSessionEnvironmentId } from '../../web-session-tabs-sync/workspace-selection/web-runtime-session-workspace-routing'
import { useAppStore } from '../../../store/index'
import type {
  CreateWebRuntimeSessionTerminalArgs,
  WebRuntimeTerminalCreateOutcome,
  CreateWebRuntimeSessionTerminalOnHostArgs,
  CreatedWebRuntimeSessionTerminal
} from './terminal-create-contracts'
import { notifyWebRuntimeTerminalCreateFailure } from './web-runtime-terminal-create-failure-notice'
import {
  startStoppedWslHostForUserAct,
  stoppedWslHostMessage
} from '../../hosts/wsl/wsl-host-user-start'

type TerminalCreateOptions = { notifyFailure?: boolean; userAct?: boolean }

/**
 * Toast host failure here because no mirrored pane can show it; callers reporting themselves use
 * notifyFailure:false. `userAct` marks a New Terminal the user asked for: it may start a stopped WSL
 * host, which nothing automatic does (E9).
 */
export async function createWebRuntimeSessionTerminal(
  args: CreateWebRuntimeSessionTerminalArgs,
  options: TerminalCreateOptions = {}
): Promise<WebRuntimeTerminalCreateOutcome> {
  return await createWebRuntimeTerminal(args, options, () =>
    createWebRuntimeSessionTerminalResult({
      ...args,
      environmentId: resolveWebRuntimeSessionEnvironmentId(
        args.environmentId,
        useAppStore.getState().settings?.activeRuntimeEnvironmentId
      )
    })
  )
}

export async function createWebRuntimeSessionTerminalOnHost(
  args: CreateWebRuntimeSessionTerminalOnHostArgs,
  options: TerminalCreateOptions = {}
): Promise<WebRuntimeTerminalCreateOutcome> {
  return await createWebRuntimeTerminal(args, options, () =>
    createWebRuntimeSessionTerminalResult(args)
  )
}

async function createWebRuntimeTerminal(
  args: CreateWebRuntimeSessionTerminalArgs,
  options: TerminalCreateOptions,
  create: () => Promise<CreatedWebRuntimeSessionTerminal>
): Promise<WebRuntimeTerminalCreateOutcome> {
  if (options.userAct && !(await startStoppedWslHostForUserAct(args.environmentId))) {
    // The start already told the user why; the host is still stopped.
    return { status: 'failed', message: stoppedWslHostMessage(args.environmentId) }
  }
  const created = await create()
  if (created.outcome.status === 'created' && created.warning) {
    try {
      toast.info(created.warning)
    } catch (error) {
      console.warn('Terminal launch notice failed', error)
    }
  }
  if (
    created.hostFailed &&
    created.outcome.status === 'failed' &&
    options.notifyFailure !== false
  ) {
    notifyWebRuntimeTerminalCreateFailure(created.outcome.message, {
      environmentId: args.environmentId ?? null,
      worktreeId: args.worktreeId
    })
  }
  return created.outcome
}
