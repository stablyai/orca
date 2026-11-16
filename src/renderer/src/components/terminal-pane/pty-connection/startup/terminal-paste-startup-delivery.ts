import { waitForRuntimeTerminalSetup } from '@/runtime/hosted-terminals/inspection/runtime-terminal-setup'
import { waitForTerminalOutputParsed } from '@/lib/pane-manager/terminal-output/pane-terminal-output-scheduler'
import { executeTerminalStartupCommandPaste } from '../../input/paste/terminal-startup-command-paste'
import { resolveTerminalPasteRuntime } from '../../input/paste/terminal-paste-runtime'
import { CLIENT_PLATFORM } from '@/lib/workspace/creation/new-workspace'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

export function bindTerminalPasteStartupDelivery(session: ConnectPanePtySession): void {
  let setupAbort: AbortController | undefined
  session.waitTeardowns.push(() => setupAbort?.abort())
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
  session.schedulePendingStartupCommandDelivery = (): void => {
    setupAbort?.abort()
    setupAbort = undefined
    const startup = session.pendingStartupCommand
    if (!startup || startup.resumeSource?.cancelled) {
      return
    }
    if (session.startupInjectTimer !== null) {
      clearTimeout(session.startupInjectTimer)
    }
    const generation = session.transportStreamGeneration
    const isCurrent = (): boolean =>
      !session.disposed &&
      session.pendingStartupCommand === startup &&
      !startup.resumeSource?.cancelled &&
      generation === session.transportStreamGeneration &&
      (startup.isCurrent?.() ?? true)
    session.startupInjectTimer = setTimeout(() => {
      session.startupInjectTimer = null
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
        const ptyId = session.transport.getPtyId()
        if (!ptyId) {
          return
        }
        const abort = new AbortController()
        setupAbort = abort
        try {
          await waitForRuntimeTerminalSetup(ptyId, abort.signal)
        } catch {
          if (!abort.signal.aborted && isCurrent()) {
            session.deps.onPtyErrorRef?.current?.(
              session.pane.id,
              `${session.startupDraftAgent ?? 'Agent'} did not start because Setup could not be confirmed. Check the Setup terminal and try again.`
            )
          }
          return
        }
        if (!isCurrent()) {
          return
        }
        const command = startup.command
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
      })()
    }, 50)
  }
}
