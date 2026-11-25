// Orca Cloud lists a message's files as trailing lines under its words. Both the prompt's download
// hints and the automatic image fetch read those same lines, so the scan lives in one place.
export const CONNECTOR_FILE_LINE =
  /^\[(?:image|file): .+, file [A-Za-z0-9]{1,64}\]$|^\[file Slack does not show\]$/
const NAMED_FILE_LINE = /^\[(image|file): .+, file ([A-Za-z0-9]{1,64})\]$/

export type ConnectorFileLine = { id: string; image: boolean }

/** Files on the message, in order. Only the trailing list is metadata; the same words higher up are
 *  the person's own. A line that names no id still ends the scan. */
export function connectorFileLines(text: string): ConnectorFileLine[] {
  const lines = text.trimEnd().split('\n')
  const files: ConnectorFileLine[] = []
  for (
    let index = lines.length - 1;
    index >= 0 && CONNECTOR_FILE_LINE.test(lines[index]!);
    index -= 1
  ) {
    const named = NAMED_FILE_LINE.exec(lines[index]!)
    if (named) {
      files.unshift({ id: named[2]!, image: named[1] === 'image' })
    }
  }
  return files
}
