import type { ConnectorSource } from './external-conversation-link'
import { connectorFileLines } from './connector-file-lines'

const FILE_ID = /^[A-Za-z0-9_-]{1,64}$/
const FILE_TYPE = /^[a-z0-9.+-]{1,64}\/[a-z0-9.+-]{1,64}$/i
const MAX_NAME_LENGTH = 64
// A Slack message ref as an action ref: a DM (`slack:T:D…::ts`), a post (`slack:T:C…:ts`) or a
// thread reply (`slack:T:C…:thread:ts`). A person ref has no timestamp, so it is never a download ref.
const SLACK_DOWNLOAD_REF = /^slack:[A-Z0-9]+:[A-Z0-9]+:(?:\d+\.\d+|\d+\.\d+:\d+\.\d+|:\d+\.\d+)$/

// A part of the request Orca doesn't carry: the bot asks for it rather than guessing.
export const connectorPartNotShown = (what: string) =>
  `[Orca: part of their request isn't shown here (${what}); ask them for it before acting on that part]`

function shownName(name: string | undefined): string | null {
  const shown = name
    ?.normalize('NFKC')
    .replace(/[^\p{L}\p{M}\p{N} .'_-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH)
    .trim()
  return shown ? shown : null
}

/** A download command the agent can actually run, or a note that the file can't be had. */
export function connectorFileDownloadHint(
  id: string,
  name: string,
  type: string,
  messageRef: string | undefined
): string {
  const ref = messageRef && SLACK_DOWNLOAD_REF.test(messageRef) ? messageRef : null
  if (ref === null || !FILE_ID.test(id)) {
    return connectorPartNotShown('a file in it')
  }
  const shown = shownName(name) ?? 'a file'
  const mime = type && FILE_TYPE.test(type) ? `, ${type}` : ''
  return `[Orca: file ${id}: ${shown}${mime}; \`orca slack read ${ref} --download ${id}\` saves it]`
}

/** Hints for the files a message lists at the end of its text. Only Slack refs are action refs. */
export function connectorFileDownloadHints(
  source: ConnectorSource,
  text: string,
  messageRef: string | undefined
): string[] {
  if (source !== 'slack') {
    return []
  }
  return connectorFileLines(text).map((file) =>
    connectorFileDownloadHint(file.id, file.id, '', messageRef)
  )
}
