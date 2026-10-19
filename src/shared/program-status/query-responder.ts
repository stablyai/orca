import { isProgramStatusQueryBody, PROGRAM_STATUS_QUERY_REPLY } from './protocol'

type OscHandlerParser = {
  registerOscHandler: (
    ident: number,
    callback: (data: string) => boolean
  ) => { dispose: () => void }
}

/**
 * Answers `OSC 7501 ; ?` so Program Status Protocol programs (Claude Code, pi) start reporting.
 * Why one shared handler: the visible renderer xterm and main's hidden-pane emulator each own
 * replies for different chunks, and both must answer before the DA1 sentinel that follows.
 */
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
