import { CONNECTOR_REPLY_MAX_FILES } from '../connector-action-contract'
import { splitHtmlDocumentFences } from '../markdown/html-document-fences'
import { redactLocalPaths } from './slack-local-paths'

/** Split out pages only when they fit one upload and Slack's text formatter leaves them intact. */
export function splitSlackHtmlReply(text: string): { text: string; documents: string[] } | null {
  const split = splitHtmlDocumentFences(text)
  if (split.documents.length === 0 || split.documents.length > CONNECTOR_REPLY_MAX_FILES) {
    return null
  }
  return split.documents.every((document) => redactLocalPaths(document) === document) ? split : null
}
