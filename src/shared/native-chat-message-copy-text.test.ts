import { describe, expect, it } from 'vitest'
import { nativeChatMessageCopyText } from './native-chat-message-copy-text'

import { subagentGroupFallbackText } from './native-chat/transcript/native-chat-subagent-summary'
import type { NativeChatSubagentEntry } from './native-chat-types'

describe('nativeChatMessageCopyText', () => {
  it('leaves out the roster twin a drawn subagent group replaces', () => {
    const agents: NativeChatSubagentEntry[] = [{ id: 'a', label: 'Explore', state: 'completed' }]
    expect(
      nativeChatMessageCopyText({
        role: 'assistant',
        blocks: [
          { type: 'text', text: 'Looking around.' },
          { type: 'subagent-group', groupId: 'g', agents },
          { type: 'text', text: subagentGroupFallbackText(agents) }
        ]
      })
    ).toBe('Looking around.')
  })

  it('drops agent visual lines but keeps them in the user’s own words', () => {
    const text = 'Chart:\n::orca-visual{file="usage.html"}\nDone.'
    expect(nativeChatMessageCopyText({ role: 'assistant', blocks: [{ type: 'text', text }] })).toBe(
      'Chart:\nDone.'
    )
    expect(nativeChatMessageCopyText({ role: 'user', blocks: [{ type: 'text', text }] })).toBe(text)
  })
})
