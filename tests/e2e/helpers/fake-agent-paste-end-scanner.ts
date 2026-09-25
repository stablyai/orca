export type FakeAgentPasteEndScan = {
  tail: string
  pasteBeginOffset: number | null
  pasteEndOffset: number | null
}

export function scanFakeAgentPasteEnd(tail: string, input: string): FakeAgentPasteEndScan {
  const beginMarker = '\x1b[200~'
  const endMarker = '\x1b[201~'
  const candidate = tail + input
  const beginIndex = candidate.indexOf(beginMarker)
  const endIndex = candidate.indexOf(endMarker)
  return {
    tail: candidate.slice(1 - endMarker.length),
    pasteBeginOffset: beginIndex === -1 ? null : beginIndex + beginMarker.length - tail.length,
    pasteEndOffset: endIndex === -1 ? null : endIndex + endMarker.length - tail.length
  }
}

/** Fallback ACK delay so an unbracketed delivery path fails an assertion instead of timing out the suite. */
export const FAKE_AGENT_UNBRACKETED_ACK_GRACE_MS = 2_000

export const FAKE_AGENT_PASTE_END_SCANNER_SOURCE = `
const scanFakeAgentPasteEnd = ${scanFakeAgentPasteEnd.toString()}
let fakeAgentPasteEndTail = ''
let fakeAgentInsidePaste = false
let fakeAgentSawPasteEnd = false
let fakeAgentSawSubmit = false
let fakeAgentUnbracketedAckTimer = null
function fakeAgentMaybeAck(scan, input, ack) {
  const events = []
  if (scan.pasteBeginOffset !== null) {
    events.push({ offset: scan.pasteBeginOffset, type: 'begin' })
  }
  if (scan.pasteEndOffset !== null) {
    events.push({ offset: scan.pasteEndOffset, type: 'end' })
  }
  for (let offset = input.indexOf('\\r'); offset >= 0; offset = input.indexOf('\\r', offset + 1)) {
    events.push({ offset, type: 'submit' })
  }
  events.sort((left, right) => left.offset - right.offset || (left.type === 'submit' ? 1 : -1))
  for (const event of events) {
    if (fakeAgentSawSubmit) break
    if (event.type === 'begin') {
      fakeAgentInsidePaste = true
    } else if (event.type === 'end') {
      if (fakeAgentInsidePaste) {
        fakeAgentInsidePaste = false
        fakeAgentSawPasteEnd = true
      }
    } else if (!fakeAgentInsidePaste) {
      fakeAgentSawSubmit = true
    }
  }
  if (!fakeAgentSawSubmit) return
  if (fakeAgentSawPasteEnd) {
    if (fakeAgentUnbracketedAckTimer) {
      clearTimeout(fakeAgentUnbracketedAckTimer)
      fakeAgentUnbracketedAckTimer = null
    }
    fakeAgentInsidePaste = false
    fakeAgentSawPasteEnd = false
    fakeAgentSawSubmit = false
    ack('bracketed')
    return
  }
  if (fakeAgentUnbracketedAckTimer) return
  fakeAgentUnbracketedAckTimer = setTimeout(() => {
    fakeAgentUnbracketedAckTimer = null
    fakeAgentInsidePaste = false
    fakeAgentSawPasteEnd = false
    fakeAgentSawSubmit = false
    ack('unbracketed')
  }, ${FAKE_AGENT_UNBRACKETED_ACK_GRACE_MS})
}
`
