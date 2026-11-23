import type { PendingStartupCommand } from './fresh-spawn-types'
import { CLIENT_PLATFORM } from '@/lib/workspace/creation/new-workspace'
import { resolveTerminalPasteRuntime } from '../../input/paste/terminal-paste-runtime'
import { executeTerminalStartupCommandPaste } from '../../input/paste/terminal-startup-command-paste'
import { waitForTerminalOutputParsed } from '@/lib/pane-manager/terminal-output/pane-terminal-output-scheduler'
import { useAppStore } from '@/store'
import { readHostLaunchPaths } from '@/lib/agent-session/launch/inventory/read-host-launch-paths'
import { readRuntimeStatuses } from '@/store/slices/runtime-status/views/runtime-status-owner'
import {
  getConnectionIdForWorktreeCopy,
  getConnectionIdFromState
} from '@/lib/workspace/ownership/connection-owner-resolution'
import {
  resolveAgentResumeLaunchTarget,
  resolveRuntimeHostReportedPlatform,
  resolveRuntimeHostTerminalWindowsShell,
  resolveSshHostReportedPlatform
} from '@/lib/agent-session/resume/agent-resume-launch-target'
import { readManagedAgentCommandsForWorktree } from '@/lib/agent-session/launch/inventory/agent-detection-target-inventory'
import {
  isTuiAgent,
  TUI_AGENT_CONFIG
} from '../../../../../../shared/agent-launch/catalog/tui-agent-config'
import { parseExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import {
  isFreshOmpLaunchCommand,
  prepareFreshOmpLaunch
} from '../../../../../../shared/agent-launch/startup/omp-fresh-launch'
import { readLaunchPosition } from '../../../../../../shared/agent-launch/startup/launch-position'
import {
  replaceLaunchExecutable,
  stockLaunchProgram
} from '../../../../../../shared/agent-launch/startup/managed-agent-launch-program'
import { withCodexDirectLaunchCommand } from '../../../../../../shared/agent-launch/startup/codex-startup-image-command'
import { resolveStartupShell } from '../../../../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { withPowerShellClaudeNativeArgs } from '../../../../../../shared/agent-launch/startup/powershell-native-launch'
import { normalizeRuntimePathForComparison } from '../../../../../../shared/file-access/cross-platform-path'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

async function prepareQueuedAgentCommand(
  session: ConnectPanePtySession,
  command: string
): Promise<string> {
  const state = useAppStore.getState()
  const worktreeId = session.deps.worktreeId
  const owner = parseExecutionHostId(session.executionHostId)
  const connectionId = session.executionHostId
    ? getConnectionIdForWorktreeCopy(state, worktreeId, session.executionHostId)
    : getConnectionIdFromState(state, worktreeId)
  const statuses = readRuntimeStatuses()
  const target = resolveAgentResumeLaunchTarget({
    projectRuntime: session.projectRuntime,
    connectionId,
    executionHostId: session.executionHostId,
    worktreePath: session.worktree?.path,
    terminalWindowsShell: state.settings?.terminalWindowsShell,
    tabShellOverride: session.shellOverride,
    remotePlatform: resolveSshHostReportedPlatform(
      state,
      session.executionHostId,
      session.transport.getRuntimeEnvironmentId?.() ?? null,
      connectionId
    ),
    runtimeHostPlatform: resolveRuntimeHostReportedPlatform(statuses, session.executionHostId),
    runtimeHostTerminalWindowsShell: resolveRuntimeHostTerminalWindowsShell(
      statuses,
      session.executionHostId
    )
  })
  const shell = resolveStartupShell(target.platform, target.shell)
  const align = async (command: string): Promise<string> => {
    const launch = readLaunchPosition(command, shell)
    if (!launch) {
      return command
    }
    const cached = readManagedAgentCommandsForWorktree(state, worktreeId)
    const program = normalizeRuntimePathForComparison(launch.executable)
    const agent = Object.keys(TUI_AGENT_CONFIG)
      .filter(isTuiAgent)
      .find(
        (id) =>
          stockLaunchProgram(id, target.platform) === launch.executable ||
          cached?.[id] === launch.executable ||
          // The inventory's release path proves which root belongs to this host.
          (cached?.[id] &&
            program.includes('/agent-runtimes/') &&
            sameManagedRoot(program, normalizeRuntimePathForComparison(cached[id])))
      )
    const override = agent && state.settings?.agentCmdOverrides?.[agent]
    if (
      agent &&
      !connectionId &&
      owner?.kind !== 'ssh' &&
      (!override ||
        readLaunchPosition(override, shell)?.executable !== launch.executable ||
        launch.executable === stockLaunchProgram(agent, target.platform))
    ) {
      const paths = await readHostLaunchPaths(
        state,
        owner?.kind === 'runtime'
          ? { kind: 'environment', environmentId: owner.environmentId }
          : { kind: 'local' },
        worktreeId
      )
      if (paths) {
        return replaceLaunchExecutable(
          command,
          shell,
          launch,
          paths[agent] ?? stockLaunchProgram(agent, target.platform)
        )
      }
    }
    return command
  }
  command = isFreshOmpLaunchCommand(command)
    ? await prepareFreshOmpLaunch(command, shell, align)
    : await align(command)
  const codex = withCodexDirectLaunchCommand(command, shell, {
    images: state.settings?.terminalInlineImages !== false,
    probeInShell: true
  })
  return shell === 'powershell' && codex === command
    ? withPowerShellClaudeNativeArgs(command)
    : codex
}

function sameManagedRoot(path: string, installed: string): boolean {
  const marker = '/agent-runtimes/'
  const start = installed.indexOf(marker)
  const end = installed.indexOf('/', start + marker.length)
  return start !== -1 && end !== -1 && path.startsWith(installed.slice(0, end + 1))
}

export function bindQueuedStartupCommandDelivery(session: ConnectPanePtySession): void {
  const isStartupPasteTargetCurrent = (ptyId: string | null): boolean =>
    !session.disposed &&
    session.deps.paneTransportsRef.current.get(session.pane.id) === session.transport &&
    session.transport.getPtyId() === ptyId
  const runTerminalPasteStartupCommand = async (
    command: string,
    current: () => boolean
  ): Promise<boolean> => {
    const ptyId = session.transport.getPtyId()
    const result = await executeTerminalStartupCommandPaste({
      command,
      pane: session.pane,
      ptyId,
      runtime: resolveTerminalPasteRuntime({
        platform: CLIENT_PLATFORM,
        ptyId,
        transport: session.transport,
        isWindowsConpty: session.isNativeWindowsConpty
      }),
      transport: session.transport,
      isTargetCurrent: (target) => current() && isStartupPasteTargetCurrent(target)
    })
    if (result.status !== 'pasted' || !current() || !isStartupPasteTargetCurrent(ptyId)) {
      return false
    }
    return session.transport.sendInput('\r', 'launch')
  }
  let deliveringStartup: { startup: PendingStartupCommand; generation: number } | undefined
  session.schedulePendingStartupCommandDelivery = (): void => {
    const startup: PendingStartupCommand | null = session.pendingStartupCommand
    const generation: number = session.transportStreamGeneration
    if (
      !startup ||
      (deliveringStartup?.startup === startup && deliveringStartup.generation === generation) ||
      startup.resumeSource?.cancelled
    ) {
      return
    }
    if (session.startupInjectTimer !== null) {
      clearTimeout(session.startupInjectTimer)
    }
    const isCurrent = (): boolean =>
      !session.disposed &&
      session.pendingStartupCommand === startup &&
      !startup.resumeSource?.cancelled &&
      generation === session.transportStreamGeneration &&
      (startup.isCurrent?.() ?? true)
    session.startupInjectTimer = setTimeout(() => {
      session.startupInjectTimer = null
      const delivery = { startup, generation }
      deliveringStartup = delivery
      void (async () => {
        if (!isCurrent()) {
          return
        }
        if (session.shouldDeliverStartupViaTerminalPaste) {
          await waitForTerminalOutputParsed(session.pane.terminal)
        }
        if (!isCurrent()) {
          return
        }
        const command = await prepareQueuedAgentCommand(session, startup.command)
        if (!isCurrent()) {
          return
        }
        const submitted = session.shouldDeliverStartupViaTerminalPaste
          ? await runTerminalPasteStartupCommand(command, isCurrent)
          : session.transport.sendInput(`${command}\r`, 'launch')
        if (submitted) {
          session.armStartupDraftReadinessObservation()
        } else {
          session.releaseUnattemptedStartupDraftPasteDelivery()
        }
        if (session.pendingStartupCommand === startup) {
          session.pendingStartupCommand = null
        }
      })().finally(() => {
        if (deliveringStartup === delivery) {
          deliveringStartup = undefined
        }
      })
    }, 50)
  }
}
