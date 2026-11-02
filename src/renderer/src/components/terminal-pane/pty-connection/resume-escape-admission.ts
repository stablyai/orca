import { isRemoteRuntimePtyId } from '../../../../../shared/remote-runtime/remote-runtime-pty-id'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

type DeliveredChunk = {
  data: string
  seq?: number
  rawLength?: number
  gapEscapeState?: string
  transformed?: boolean
}

/** Admit `data` (the delivered chunk or a suffix of it) into xterm without printing an orphaned escape tail. */
export function admitResumedAppChunk(
  session: ConnectPanePtySession,
  data: string,
  delivered: DeliveredChunk,
  parserEscape: string = session.idleCursorReset.parserEscape
): string {
  const rawLength = delivered.rawLength ?? delivered.data.length
  const whole = data === delivered.data
  // A whole chunk spans its raw seq range even when main stripped agent status (labels describe delivered bytes);
  // a sliced or carved suffix maps onto seq only when nothing was stripped.
  const exactSuffix =
    !whole &&
    rawLength === delivered.data.length &&
    delivered.transformed !== true &&
    delivered.data.endsWith(data)
  const mappable = whole || exactSuffix
  const ptyId = session.transport.getPtyId()
  // Remote runtime seq counts frames, not chars.
  const endSeq =
    typeof delivered.seq === 'number' && !isRemoteRuntimePtyId(ptyId) ? delivered.seq : undefined
  session.resumeEscapeGap.bindStream(ptyId)
  return session.resumeEscapeGap.admit(
    {
      data,
      startSeq:
        mappable && endSeq !== undefined ? endSeq - (whole ? rawLength : data.length) : undefined,
      mappable,
      // The label describes main's first delivered byte only.
      gapEscapeState: whole ? delivered.gapEscapeState : undefined
    },
    {
      paintedSeq:
        ptyId !== null && session.rendererOrderedPtyId === ptyId
          ? (session.rendererOrderedSeq ?? null)
          : null,
      parserEscape
    }
  )
}
