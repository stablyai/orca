import { describe, expect, it } from 'vitest'

import { detectAgentSendTitleStatus } from './agent-send-title-status'

describe('detectAgentSendTitleStatus Gemini idle glyph', () => {
  it('treats a leading idle glyph as ready', () => {
    expect(detectAgentSendTitleStatus('◇ Gemini CLI')).toBe('idle')
  })

  it.each(['codex ◇ ~/orca', 'gemini ~/x◇'])('does not treat buried glyph %j as ready', (title) => {
    expect(detectAgentSendTitleStatus(title)).toBeNull()
  })
})
