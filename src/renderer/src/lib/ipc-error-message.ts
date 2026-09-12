// Electron rethrows a main-process failure to the renderer as
// "Error invoking remote method '<channel>': <ErrorClass>: <message>". Neither the channel nor the
// class name means anything to someone reading a toast, and they push the sentence that does matter
// off the visible line.
const IPC_INVOKE_PREFIX = /^Error invoking remote method '[^']*':\s*/
const ERROR_CLASS_PREFIX = /^(?:[A-Za-z_$][\w$]*)?Error:\s*/

/**
 * Strip Electron's IPC wrapper off a main-process error so the message reads as written.
 * The class-name strip only applies once a wrapper was actually removed, so a renderer-local
 * `TypeError: …` keeps its prefix.
 */
export function readableIpcErrorMessage(message: string): string {
  const withoutChannel = message.replace(IPC_INVOKE_PREFIX, '')
  return withoutChannel === message ? message : withoutChannel.replace(ERROR_CLASS_PREFIX, '')
}
