import { expect, it } from 'vitest'
import { buildCrossVendorHandoffPrompt, crossVendorHistoryRows } from './cross-vendor-handoff'
import { MAX_CONTEXT_CHARS } from '../requests/agent-session-context-budget'
import { BOT_CREATED_KICKOFF } from '../../bot-created-kickoff'

it('carries only spoken words, oldest first, and keeps the newest turns within budget', () => {
  const rows = crossVendorHistoryRows([
    { kind: 'message', role: 'user', text: BOT_CREATED_KICKOFF },
    { kind: 'message', role: 'user', text: 'My cat is called Miso.' },
    { kind: 'tool', name: 'Bash' },
    { kind: 'message', role: 'system', text: 'compacted' },
    { kind: 'message', role: 'assistant', text: '  Nice name!  ' },
    { kind: 'error', text: 'boom' }
  ])
  expect(rows).toEqual([
    { role: 'user', text: 'My cat is called Miso.' },
    { role: 'assistant', text: 'Nice name!' }
  ])
  const prompt = buildCrossVendorHandoffPrompt({
    rows,
    sourceAgent: 'Claude',
    targetAgent: 'Codex'
  })
  expect(prompt).toContain('User: My cat is called Miso.\n\nAssistant: Nice name!')
  expect(buildCrossVendorHandoffPrompt({ rows: [], sourceAgent: 'a', targetAgent: 'b' })).toBeNull()

  const long = Array.from({ length: 80 }, (_, index) => ({
    role: 'user' as const,
    text: `${index}:${'x'.repeat(1_000)}`
  }))
  const bounded = buildCrossVendorHandoffPrompt({ rows: long, sourceAgent: 'a', targetAgent: 'b' })!
  expect(bounded.length).toBeLessThan(MAX_CONTEXT_CHARS + 2_000)
  expect(bounded).toContain('79:')
  expect(bounded).not.toContain('\n\nUser: 0:')
  expect(bounded).toMatch(/\[Orca: \d+ earlier messages omitted\]/)
})
