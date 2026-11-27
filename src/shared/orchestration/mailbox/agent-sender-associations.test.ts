import { describe, expect, it } from 'vitest'
import { sameAgentSenderContent } from './agent-sender-associations'

const row = { identity: 'dispatch:a', paneKey: 't1:l1', worktreeId: 'wt-a', sessionId: 's1' }
const other = { identity: 'dispatch:b', paneKey: 't2:l2', worktreeId: 'wt-b' }
const content = {
  peerFingerprint: 'peer',
  principals: [{ peerFingerprint: 'p1', homePeerFingerprint: 'h1' }],
  associations: [row, other],
  attachments: [{ ...other, homePeerFingerprint: 'h1' }]
}

describe('sameAgentSenderContent', () => {
  it('matches what clients read: every field and row order count, absent equals undefined', () => {
    const copy = structuredClone(content)
    expect(sameAgentSenderContent(content, copy)).toBe(true)
    expect(
      sameAgentSenderContent(
        { ...content, associations: [row, { ...other, dispatchActor: undefined }] },
        copy
      )
    ).toBe(true)
    expect(sameAgentSenderContent({ ...content, associations: [other, row] }, copy)).toBe(false)
    expect(
      sameAgentSenderContent(
        { ...content, associations: [row, { ...other, dispatchActor: true }] },
        copy
      )
    ).toBe(false)
    expect(
      sameAgentSenderContent(
        { ...content, associations: [{ ...row, sessionId: 's2' }, other] },
        copy
      )
    ).toBe(false)
    expect(
      sameAgentSenderContent(
        { ...content, attachments: [{ ...other, homePeerFingerprint: 'h2' }] },
        copy
      )
    ).toBe(false)
    expect(
      sameAgentSenderContent(
        { ...content, principals: [{ peerFingerprint: 'p1', homePeerFingerprint: 'h2' }] },
        copy
      )
    ).toBe(false)
    const { peerFingerprint: _peer, ...withoutPeer } = copy
    expect(sameAgentSenderContent(content, withoutPeer)).toBe(false)
  })
})
