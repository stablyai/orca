import { expect, it, vi } from 'vitest'
import { automationOwnerBot } from '../automations/hosts/automation-owner.test-fixture'
import { transcriptBot } from './bot-transcript-bot'
import type { Bot } from '../../../../shared/bot-types'

vi.mock('@/lib/bot-catalog', () => ({}))
vi.mock('@/lib/bot-group-list', () => ({}))

// #48640: mounted transcript rows must share a catalog index instead of rescanning for each row.
it('walks each catalog snapshot once for repeated transcript lookups and rebuilds on publication', () => {
  let visits = 0
  const rows = Array.from({ length: 128 }, (_, index) =>
    automationOwnerBot(index % 2 ? 'runtime:e' : 'local', { chatSessionId: `chat-${index}` })
  )
  const snapshot = (bots: Bot[]) =>
    new Proxy(bots, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) {
          visits += 1
        }
        return Reflect.get(target, key, receiver)
      }
    })
  const owner = {
    target: { kind: 'environment', environmentId: 'e' } as const,
    sessionId: 'chat-127',
    worktreeId: 'folder:same'
  }
  const first = snapshot(rows)
  for (let row = 0; row < 128; row += 1) {
    expect(transcriptBot(first, owner)).toBe(rows[127])
  }
  expect(visits).toBe(128)
  const replacement = automationOwnerBot('runtime:e', { chatSessionId: 'chat-127' })
  const next = snapshot([...rows.slice(0, 127), replacement])
  for (let row = 0; row < 128; row += 1) {
    expect(transcriptBot(next, owner)).toBe(replacement)
  }
  expect(visits).toBe(256)
})
