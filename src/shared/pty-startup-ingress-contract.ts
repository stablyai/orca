import type { PtyOwnerBackend } from './pty-owner-backend'
import type { PtyStartupIngressIntent } from './pty-startup-ingress-intent'
import type { PtySlaveEchoProbe } from './pty-slave-line-discipline-echo'
import type { TerminalOscColorQueryReplyColors } from './terminal-osc-color-reply'

export type PtyIngressEmission = {
  data: string
  rawStartSeq: number
  rawEndSeq: number
  transformed: boolean
}

export type PtyStartupIngressOptions = {
  intent?: PtyStartupIngressIntent
  /**
   * Live OSC 10/11 answers for the whole PTY lifetime. Distinct from startup
   * `intent`: that path is once-per-slot and expires. Survey-style readers
   * (gh auth login) query after that window; a late renderer reply is `\x1b]`
   * on stdin.
   */
  liveOscColors?: TerminalOscColorQueryReplyColors
  ownerBackend?: PtyOwnerBackend
  write: (data: string) => void
  onEmission: (emission: PtyIngressEmission) => void
  /**
   * Reports whether the slave would echo a reply written to the master. When present,
   * the reply waits for `quiet` instead of relying on echo-shape recognition. Absent
   * on backends with no line discipline to read (ConPTY, wsl.exe).
   */
  echoProbe?: PtySlaveEchoProbe
}

export type PtyIngressSourceSpan = {
  data: string
  rawStartSeq: number
  rawEndSeq: number
}

export type PtyStartupIngressOperation =
  | { kind: 'data'; chunk: PtyIngressSourceSpan }
  | { kind: 'close-query' }
  | { kind: 'snapshot' }
  | { kind: 'teardown' }
  | { kind: 'expire' }
  | { kind: 'release-echo' }

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
