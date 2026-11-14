import { expect, it } from 'vitest'
import { structuredAgentSessionStatusBlock } from '../agent-session/view/structured-agent-session-status-block'
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

it('upcasts the saved unknown content from an older host without rewriting its diagnostic payload', () => {
  const body = {
    kind: 'status',
    text: 'Claude sent content Orca cannot display yet',
    providerFrame: frame()
  } as const
  const block = structuredAgentSessionStatusBlock(body)
  expect(block).toEqual({
    type: 'text',
    text: 'Claude switched models: Claude Opus 5.5 → Claude Opus 4.8.',
    tone: 'notice',
    presentation: 'turn-notice',
    providerFrame: body.providerFrame
  })
  expect(nativeChatNoticeLook(block)).toEqual({
    kind: 'model-fallback',
    from: 'claude-opus-5-5',
    to: 'claude-opus-4-8'
  })
  expect(body.text).toBe('Claude sent content Orca cannot display yet')
})

it.each([
  null,
  { type: 'fallback', from: { model: 'claude-opus-5-5' } },
  { type: 'fallback', from: { model: [] }, to: { model: 'claude-opus-4-8' } },
  { type: 'fallback', from: { model: '  ' }, to: { model: 'claude-opus-4-8' } },
  { ...fallback, type: 'future_event' }
])(
  'keeps an incomplete or different event available through the generic disclosure: %j',
  (value) => {
    const body = { kind: 'status', text: 'Unknown content', providerFrame: frame(value) } as const
    expect(structuredAgentSessionStatusBlock(body)).toEqual({
      type: 'text',
      text: body.text,
      providerFrame: body.providerFrame
    })
  }
)

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
