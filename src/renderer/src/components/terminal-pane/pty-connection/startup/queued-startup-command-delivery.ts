import type { PendingStartupCommand } from './fresh-spawn-types'
import { CLIENT_PLATFORM } from '@/lib/workspace/creation/new-workspace'
import { resolveTerminalPasteRuntime } from '../../input/paste/terminal-paste-runtime'
import { executeTerminalStartupCommandPaste } from '../../input/paste/terminal-startup-command-paste'
import { waitForTerminalOutputParsed } from '@/lib/pane-manager/terminal-output/pane-terminal-output-scheduler'
import { prepareQueuedStartupCommand } from './prepare-queued-startup-command'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

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
  let deliveringStartup:
    | { startup: PendingStartupCommand; generation: number; ptyId: string }
    | undefined
  session.schedulePendingStartupCommandDelivery = (): void => {
    const startup: PendingStartupCommand | null = session.pendingStartupCommand
    const ptyId = session.transport.getPtyId()
    const generation: number = session.transportStreamGeneration
    if (
      !startup ||
      !ptyId ||
      (deliveringStartup?.startup === startup &&
        deliveringStartup.generation === generation &&
        deliveringStartup.ptyId === ptyId) ||
      startup.resumeSource?.cancelled
    ) {
      return
    }
    if (session.startupInjectTimer !== null) {
      clearTimeout(session.startupInjectTimer)
    }
    const isCurrent = (): boolean =>
      isStartupPasteTargetCurrent(ptyId) &&
      session.pendingStartupCommand === startup &&
      !startup.resumeSource?.cancelled &&
      generation === session.transportStreamGeneration &&
      (startup.isCurrent?.() ?? true)
    session.startupInjectTimer = setTimeout(() => {
      session.startupInjectTimer = null
      const delivery = { startup, generation, ptyId }
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
        const command = await prepareQueuedStartupCommand(session, ptyId, startup, isCurrent)
        if (!isCurrent()) {
          return
        }
        const submitted = session.shouldDeliverStartupViaTerminalPaste
          ? await runTerminalPasteStartupCommand(command, isCurrent)
          : session.transport.sendInput(`${command}\r`, 'launch')
        if (!isCurrent()) {
          return
        }
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
