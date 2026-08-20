export type FakeAgentPasteEndScan = { tail: string; ended: boolean }

export function scanFakeAgentPasteEnd(tail: string, input: string): FakeAgentPasteEndScan {
  const marker = '\x1b[201~'
  const candidate = tail + input
  return {
    tail: candidate.slice(1 - marker.length),
    ended: candidate.includes(marker)
  }
}

export const FAKE_AGENT_PASTE_END_SCANNER_SOURCE = `
const scanFakeAgentPasteEnd = ${scanFakeAgentPasteEnd.toString()}
let fakeAgentPasteEndTail = ''
`
