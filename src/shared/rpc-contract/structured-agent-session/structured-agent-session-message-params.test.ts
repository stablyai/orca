// Phones parse sends with these schemas and have no Node Buffer: the size checks must not need it.
import { afterEach, expect, it, vi } from 'vitest'
import { MAX_PROMPT_BYTES, SendBody } from './structured-agent-session-message-params'

afterEach(() => {
  vi.unstubAllGlobals()
})

const body = (text: string) => ({
  kind: 'message' as const,
  role: 'user' as const,
  blocks: [{ type: 'text' as const, text }]
})

it('measures a send’s size without Buffer, as the host does', () => {
  vi.stubGlobal('Buffer', undefined)
  expect(SendBody.safeParse(body('hi é')).success).toBe(true)
  // Two bytes a character: past the limit in bytes, though not in characters.
  expect(SendBody.safeParse(body('é'.repeat(MAX_PROMPT_BYTES / 2 + 1))).success).toBe(false)
})
