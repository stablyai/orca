import { parseTerminalOscColorQuery } from '../../../../../shared/terminal-osc-color-reply'
import {
  HIDDEN_STARTUP_RENDERER_QUERY_PENDING_CHARS,
  extractHiddenStartupRendererQueryData,
  findCsiFinalByteIndex,
  isStatefulRendererReplyCsiQuery,
  isStatelessRendererReplyCsiQuery
} from '../../../../../shared/terminal-reply-query-extraction'
import type { PtyDataMeta } from '../pty-dispatcher'
import {
  DEFAULT_DA1_RESPONSE,
  sendTerminalOscColorQueryReplies
} from '../terminal-capability-replies'

import { recordHiddenRendererSkip } from './e2e-terminal-pty-harness'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

/** Hidden-pane startup renderer query extraction, output skipping, and salvage from discarded restore data. */
export function bindHiddenStartupRendererQueryWrite(session: ConnectPanePtySession): void {
  session.takeHiddenStartupRendererQueryPendingForForeground = function (data: string): {
    statelessQueryData: string
    statefulQueryData: string
    oscColorQueryData: string
    remainingData: string
    consumedCurrentChars: number
  } {
    const pending = session.hiddenStartupRendererQueryPending
    session.hiddenStartupRendererQueryPending = ''
    if (!pending) {
      return {
        statelessQueryData: '',
        statefulQueryData: '',
        oscColorQueryData: '',
        remainingData: data,
        consumedCurrentChars: 0
      }
    }

    const input = pending + data
    let statelessQueryData = ''
    let statefulQueryData = ''
    let oscColorQueryData = ''
    let consumedInputChars = pending.length
    let nextPending = ''
    if (input.startsWith('\x1b[')) {
      const finalByteIndex = findCsiFinalByteIndex(input, 2)
      if (finalByteIndex === -1) {
        nextPending = input.slice(0, HIDDEN_STARTUP_RENDERER_QUERY_PENDING_CHARS)
        consumedInputChars = input.length
      } else {
        const sequence = input.slice(0, finalByteIndex + 1)
        if (isStatelessRendererReplyCsiQuery(sequence)) {
          statelessQueryData = sequence
        } else if (isStatefulRendererReplyCsiQuery(sequence)) {
          statefulQueryData = sequence
        }
        consumedInputChars = finalByteIndex + 1
      }
    } else if (input.startsWith('\x1b]')) {
      const query = parseTerminalOscColorQuery(input, 0)
      if (query.kind === 'partial') {
        nextPending = input.slice(0, HIDDEN_STARTUP_RENDERER_QUERY_PENDING_CHARS)
        consumedInputChars = input.length
      } else if (query.kind === 'match') {
        oscColorQueryData = input.slice(0, query.endIndex)
        consumedInputChars = query.endIndex
      } else {
        consumedInputChars = pending.length
      }
    } else if (input.length === 1) {
      nextPending = input
      consumedInputChars = input.length
    } else {
      consumedInputChars = pending.length
    }

    session.hiddenStartupRendererQueryPending = nextPending
    const consumedCurrentChars = Math.max(0, consumedInputChars - pending.length)
    return {
      statelessQueryData,
      statefulQueryData,
      oscColorQueryData,
      remainingData: data.slice(consumedCurrentChars),
      consumedCurrentChars
    }
  }

  session.metaAfterConsumingCurrentChars = function (
    meta: PtyDataMeta | undefined,
    consumedCurrentChars: number
  ): PtyDataMeta | undefined {
    if (consumedCurrentChars === 0 || typeof meta?.rawLength !== 'number') {
      return meta
    }
    return {
      ...meta,
      rawLength: Math.max(0, meta.rawLength - consumedCurrentChars)
    }
  }

  session.skipHiddenRendererOutput = function (data: string): void {
    session.writeHiddenStartupRendererQueries(data)
    session.markHiddenOutputRestoreNeeded()
    session.hiddenRendererStateDirty = true
    if (session.hiddenOutputRestoreInFlight) {
      session.hiddenOutputRestoreFreshSnapshotNeeded = true
    }
    recordHiddenRendererSkip(data.length)
  }

  // Why: discarding flood bytes must not swallow terminal queries (a lost DSR/CPR hangs the program); the snapshot repaint owns the content, so synthesize replies via the immediate input path, not xterm replay.
  session.salvageRendererQueriesFromDiscardedRestoreData = function (data: string): void {
    if (!data || !data.includes('\x1b')) {
      return
    }
    const extracted = extractHiddenStartupRendererQueryData(data, '')
    if (extracted.oscColorQueryData) {
      sendTerminalOscColorQueryReplies(
        extracted.oscColorQueryData,
        session.pane.terminal,
        session.sendDesktopQueryReplyImmediate
      )
    }
    let unansweredQueryData = ''
    for (const sequence of splitCsiSequences(
      extracted.statefulQueryData + extracted.statelessQueryData
    )) {
      if (sequence === '\x1b[6n') {
        // CPR from the live buffer; may be mid-repaint stale, but in a drop scenario liveness (unblock the reader) is the contract, not accuracy.
        const buffer = session.pane.terminal.buffer.active
        const row = Math.min(buffer.cursorY + 1, session.pane.terminal.rows)
        const col = Math.min(buffer.cursorX + 1, session.pane.terminal.cols)
        session.sendDesktopQueryReplyImmediate(`\x1b[${row};${col}R`)
      } else if (sequence === '\x1b[c' || sequence === '\x1b[0c') {
        session.sendDesktopQueryReplyImmediate(DEFAULT_DA1_RESPONSE)
      } else {
        unansweredQueryData += sequence
      }
    }
    if (unansweredQueryData) {
      // Best-effort for rarer queries (DECRQM, DA2, XTVERSION): replay into xterm so its handlers answer when no replay is active.
      session.writePtyOutputToXterm(unansweredQueryData, true, { hiddenStartupRendererQuery: true })
    }
  }

  function splitCsiSequences(queryData: string): string[] {
    const sequences: string[] = []
    let offset = queryData.indexOf('\x1b[')
    while (offset !== -1) {
      const finalByteIndex = findCsiFinalByteIndex(queryData, offset + 2)
      if (finalByteIndex === -1) {
        break
      }
      sequences.push(queryData.slice(offset, finalByteIndex + 1))
      offset = queryData.indexOf('\x1b[', finalByteIndex + 1)
    }
    return sequences
  }
}
