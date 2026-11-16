import { expect, it } from 'vitest'
import { nativeChatNoticeLook } from './native-chat-notice'
import {
  CLAUDE_MODEL_FALLBACK_FRAME_KIND,
  readClaudeModelFallbackFrame
} from './claude-model-fallback'

const fallback = {
  type: 'fallback',
  from: { model: 'claude-opus-5-5' },
  to: { model: 'claude-opus-4-8' }
}

function frame(value: unknown = fallback) {
  const head = JSON.stringify(value)
  return {
    provider: 'claude',
    kind: CLAUDE_MODEL_FALLBACK_FRAME_KIND,
    payload: { head, byteLength: head.length, digest: 'fixture', truncated: false }
  }
}

it('requires a complete Claude assistant fallback frame', () => {
  const known = frame()
  for (const other of [
    { ...known, provider: 'codex' },
    { ...known, kind: 'message:user:content:fallback' },
    { ...known, payload: { ...known.payload, truncated: true } },
    { ...known, payload: { ...known.payload, head: '{' } }
  ]) {
    expect(readClaudeModelFallbackFrame(other)).toBeNull()
  }
})

it.each([
  { tone: 'error' },
  { presentation: 'plan-document' },
  { failure: { kind: 'usageLimitReached' } },
  { orcaStop: { cause: 'quit' } }
] as const)('does not replace another explicit status or failure: %j', (special) => {
  const block = {
    type: 'text',
    text: 'Keep this status',
    providerFrame: frame(),
    ...special
  } as const
  expect(nativeChatNoticeLook(block).kind).not.toBe('model-fallback')
})
