import type { RuntimeTerminalCreate } from '../../../../shared/terminal/runtime/runtime-terminal-create-contract'
import { createRemoteRuntimeInputJournal } from '../../components/terminal-pane/pty-transport/remote-runtime/input/remote-runtime-input-journal'
import type { RemoteRuntimeInputEndpoint } from '../../components/terminal-pane/pty-transport/remote-runtime/input/remote-runtime-recovery-input-hold'
import type { RemoteRuntimeMultiplexedTerminal } from '../../runtime/hosted-terminals/streams/remote-terminal-stream-contracts'

export type TauriPtyInputSession = {
  key: string
  journal: ReturnType<typeof createRemoteRuntimeInputJournal>
  current: { stream: RemoteRuntimeMultiplexedTerminal; endpoint: RemoteRuntimeInputEndpoint } | null
}

export function tauriPtyInputSessionKey(
  environmentId: string,
  opts: { tabId?: string; leafId?: string },
  terminal: RuntimeTerminalCreate
): string {
  return [
    environmentId,
    opts.tabId ?? terminal.tabId ?? terminal.handle,
    opts.leafId ?? terminal.paneKey ?? terminal.handle
  ].join('\u0000')
}

export function createTauriPtyInputSession(key: string): TauriPtyInputSession {
  let session: TauriPtyInputSession
  session = {
    key,
    journal: createRemoteRuntimeInputJournal({
      currentStream: () => session.current
    }),
    current: null
  }
  return session
}
