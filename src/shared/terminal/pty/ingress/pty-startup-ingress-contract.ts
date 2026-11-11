import type { PtyOwnerBackend } from '../lifecycle/pty-owner-backend'
import type { PtyStartupIngressIntent } from './pty-startup-ingress-intent'
import type { TerminalOscColorQueryReplyColors } from '../../protocol/queries/terminal-osc-color-reply'

export type PtyIngressEmission = {
  data: string
  rawStartSeq: number
  rawEndSeq: number
  transformed: boolean
}

export type PtyStartupIngressOptions = {
  intent?: PtyStartupIngressIntent
  ownerBackend?: PtyOwnerBackend
  /** This PTY's viewer colours (its project's, else host-wide), read per query so a theme
   *  change reaches a long-lived pane. Defaults to this process's host-wide colours. */
  resolveHostColors?: () => TerminalOscColorQueryReplyColors | null
  /** Lets the owner drop a colour reply once another group holds the terminal; ConPTY has none. */
  readForegroundGroup?: PtyForegroundGroupReader
  write: (data: string) => void
  onEmission: (emission: PtyIngressEmission) => void
}

/** The PTY's foreground process group (tcgetpgrp); null or undefined when it cannot be read. */
export type PtyForegroundGroupReader = () => number | null | undefined

export type PtyIngressSourceSpan = {
  data: string
  rawStartSeq: number
  rawEndSeq: number
}

export type PtyStartupIngressOperation =
  // `charged`: the rest of a read already charged against the echo search budget.
  | { kind: 'data'; chunk: PtyIngressSourceSpan; charged?: boolean }
  // A reply's echo already claimed in its read, emitted suppressed once a colour query held ahead of it settles.
  | { kind: 'echo'; chunk: PtyIngressSourceSpan }
  | { kind: 'close-query' }
  | { kind: 'snapshot'; final: boolean }
  | { kind: 'teardown' }
  | { kind: 'expire' }
  | { kind: 'release-echo' }
  | { kind: 'release-query' }
  | { kind: 'asker-wait' }

export function slicePtyIngressSourceSpan(
  span: PtyIngressSourceSpan,
  start: number,
  end = span.data.length
): PtyIngressSourceSpan {
  return {
    data: span.data.slice(start, end),
    rawStartSeq: span.rawStartSeq + start,
    rawEndSeq: span.rawStartSeq + end
  }
}

export function combinePtyIngressSourceSpans(
  first: PtyIngressSourceSpan | null,
  second: PtyIngressSourceSpan
): PtyIngressSourceSpan {
  if (!first) {
    return second
  }
  return {
    data: first.data + second.data,
    rawStartSeq: first.rawStartSeq,
    rawEndSeq: second.rawEndSeq
  }
}
