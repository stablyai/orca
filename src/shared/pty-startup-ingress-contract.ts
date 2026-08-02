import type { PtyOwnerBackend } from './pty-owner-backend'
import type { PtyStartupIngressIntent } from './pty-startup-ingress-intent'

export type PtyIngressEmission = {
  data: string
  rawStartSeq: number
  rawEndSeq: number
  transformed: boolean
}

export type PtyStartupIngressOptions = {
  intent?: PtyStartupIngressIntent
  ownerBackend?: PtyOwnerBackend
  write: (data: string) => void
  onEmission: (emission: PtyIngressEmission) => void
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
