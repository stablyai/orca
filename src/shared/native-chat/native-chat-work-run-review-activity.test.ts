import { describe, expect, it } from 'vitest'
import {
  nativeChatWorkRunMember,
  nativeChatWorkRunEntries
} from './transcript/folding/native-chat-work-run'
import { approvalReviewMessage } from '../native-chat-activity.test-fixture'

describe('successful automatic review activity', () => {
  it('joins only proven successful review notices to routine work', () => {
    const approved = approvalReviewMessage('approved')
    expect(nativeChatWorkRunMember(approved, false, false)).toBe('notice')
    expect(nativeChatWorkRunMember(approved, true, false)).toBeNull()
    for (const text of [
      'Automatic approval review rejected: not authorized.',
      'Automatic approval review denied: not authorized.',
      'Automatic approval review timed out.',
      'Automatic approval review approved (risk: low):',
      'Review required before continuing.',
      'Quoted: Automatic approval review approved (risk: low): allowed.'
    ]) {
      expect(nativeChatWorkRunMember(approvalReviewMessage('other', text), false, false)).toBeNull()
    }
  })

  it('retains review details in order around a tool call', () => {
    const before = approvalReviewMessage('before')
    const after = approvalReviewMessage('after')
    const call = {
      type: 'tool-call',
      name: 'Bash',
      input: { command: 'pnpm test' },
      state: 'completed'
    } as const
    const action = { ...before, id: 'action', role: 'assistant' as const, blocks: [call] }
    const entries = nativeChatWorkRunEntries([before, action, after])
    expect(entries.blocks).toEqual([call])
    expect([...entries.asidesBefore.values()].flat()).toContain(before)
    expect(entries.asidesAfter).toContain(after)
  })
})
