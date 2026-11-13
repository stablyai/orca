import { isProgramStatusQueryBody, PROGRAM_STATUS_QUERY_REPLY } from './protocol'

type OscHandlerParser = {
  registerOscHandler: (
    ident: number,
    callback: (data: string) => boolean
  ) => { dispose: () => void }
}

/** Share OSC 7501 query replies across visible xterm and hidden-pane emulators; the owning parser must answer before the DA1 sentinel. */
export function installProgramStatusQueryResponder(deps: {
  parser: OscHandlerParser
  /** Must already be gated to the reply owner for the chunk being parsed. */
  emitReply: (reply: string) => void
  /** False while replaying restored bytes, whose queries answer no one. */
  shouldReply?: () => boolean
}): { dispose: () => void } {
  return deps.parser.registerOscHandler(7501, (data) => {
    if (isProgramStatusQueryBody(data) && deps.shouldReply?.() !== false) {
      deps.emitReply(PROGRAM_STATUS_QUERY_REPLY)
    }
    // Reports are read from the PTY stream upstream; nothing here draws.
    return true
  })
}
