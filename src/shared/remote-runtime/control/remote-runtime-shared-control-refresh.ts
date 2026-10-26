import { remoteRuntimeUnavailableError } from '../requests/remote-runtime-request-frames'

export function refreshRemoteRuntimeSharedControl(options: {
  intentionallyClosed: boolean
  ready: boolean
  close: (error: Error) => void
  open: () => void
}): void {
  if (!options.intentionallyClosed && !options.ready) {
    options.close(remoteRuntimeUnavailableError('Refreshing remote runtime control transport.'))
    options.open()
  }
}
