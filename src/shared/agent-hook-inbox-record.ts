// The on-disk shape of one hook event committed by a managed hook script: the POST body the
// script used to send, written as a file the execution host drains. Shared by the POSIX script
// builder (writer) and the main/relay drainers (reader) so the two cannot drift.
//
//   <payload bytes, unchanged>
//   \n orca-hook-record v1
//   source=<agent hook source>
//   paneKey=… tabId=… worktreeId=… env=… version=… launchToken=… [hookEventName=…] [grokHome=…]
//   orca-hook-end\n
//
// Payload first so a writer can stream stdin into the file and append the trailer afterwards.
// A record is complete only once its last line is the end marker, so the single write that
// commits it needs no rename.

import { HOOK_REQUEST_MAX_BYTES } from './agent-hook-listener/request-body'

export const AGENT_HOOK_INBOX_DIR_NAME = 'hook-inbox'
export const AGENT_HOOK_INBOX_RECORD_SUFFIX = '.rec'
/** Endpoint-file key a drainer publishes once it owns the inbox. Scripts read the file, not the
 *  env var, so a value inherited from an older Orca cannot enable the inbox. */
export const AGENT_HOOK_INBOX_ENDPOINT_KEY = 'ORCA_AGENT_HOOK_INBOX'
export const AGENT_HOOK_INBOX_ENDPOINT_VALUE = '1'
export const AGENT_HOOK_INBOX_RECORD_MARKER = 'orca-hook-record v1'
export const AGENT_HOOK_INBOX_RECORD_END = 'orca-hook-end'
/** Larger payloads take the POST path, which rejects them just as it does today. The shell counts
 *  characters, so the reader allows for four-byte UTF-8 on top of this. */
export const AGENT_HOOK_INBOX_MAX_PAYLOAD_CHARS = HOOK_REQUEST_MAX_BYTES
/** A backlog this deep means nothing is draining (Orca closed while agents run on): writers shed
 *  tool progress there but keep lifecycle events, so the replay still ends on the final state.
 *  Far above anything a stalled but live Orca accumulates, whose tool events it still needs. */
export const AGENT_HOOK_INBOX_TOOL_PROGRESS_BACKLOG_LIMIT = 2000

/** Trailer keys copied into the hook body. Anything else is ignored, so a trailer can never set
 *  transport fields such as `isReplay` or `payload`. */
const TRAILER_BODY_KEYS = new Set([
  'paneKey',
  'tabId',
  'worktreeId',
  'env',
  'version',
  'launchToken',
  'hookEventName',
  'hook_event_name',
  'grokHome'
])

export type AgentHookInboxRecord = {
  source: string
  body: Record<string, string>
}

export type AgentHookInboxRecordParse =
  | { kind: 'complete'; record: AgentHookInboxRecord }
  | { kind: 'incomplete' }
  | { kind: 'invalid' }

const END_LINE = Buffer.from(`\n${AGENT_HOOK_INBOX_RECORD_END}`)
const MARKER_LINE = Buffer.from(`\n${AGENT_HOOK_INBOX_RECORD_MARKER}`)

/** Whether `tail` (the last bytes of a record file) ends with the end marker line. */
export function endsWithAgentHookInboxRecordEnd(tail: Buffer): boolean {
  let end = tail.length
  if (end > 0 && tail[end - 1] === 0x0a) {
    end -= 1
    if (end > 0 && tail[end - 1] === 0x0d) {
      end -= 1
    }
  } else {
    return false
  }
  return end >= END_LINE.length && tail.subarray(end - END_LINE.length, end).equals(END_LINE)
}

export function parseAgentHookInboxRecord(bytes: Buffer): AgentHookInboxRecordParse {
  if (!endsWithAgentHookInboxRecordEnd(bytes)) {
    return { kind: 'incomplete' }
  }
  // Why the LAST marker: a raw newline cannot occur inside a JSON string, so payload text cannot
  // forge a marker line after the real one.
  const markerAt = bytes.lastIndexOf(MARKER_LINE)
  if (markerAt === -1) {
    return { kind: 'invalid' }
  }
  const trailer = bytes
    .subarray(markerAt + MARKER_LINE.length)
    .toString('utf8')
    .split(/\r?\n/)
  let source = ''
  const body: Record<string, string> = {}
  for (const line of trailer) {
    const separator = line.indexOf('=')
    if (separator <= 0) {
      continue
    }
    const key = line.slice(0, separator)
    const value = line.slice(separator + 1)
    if (key === 'source') {
      source ||= value
    } else if (TRAILER_BODY_KEYS.has(key) && !(key in body)) {
      body[key] = value
    }
  }
  if (!source || !body.paneKey) {
    return { kind: 'invalid' }
  }
  let payloadEnd = markerAt
  if (payloadEnd > 0 && bytes[payloadEnd - 1] === 0x0d) {
    payloadEnd -= 1
  }
  body.payload = bytes.subarray(0, payloadEnd).toString('utf8')
  return { kind: 'complete', record: { source, body } }
}
