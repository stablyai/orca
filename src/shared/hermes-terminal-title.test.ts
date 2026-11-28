import { describe, expect, it } from 'vitest'
import { hermesNativeTitleStatus } from './hermes-terminal-title'

describe('Hermes native session title markers', () => {
  it.each([
    ['hermes', '✓ Run Orca dispatched worker … · grok-4.7 · ~/workspace', 'idle'],
    ['hermes', '⏳ Ready to deploy', 'working'],
    ['hermes', '⚠ Finished the changes', 'permission'],
    ['hermes', '⚠️ Waiting for approval', 'permission'],
    ['hermes', 'user@host: ~/workspace', null],
    ['hermes', '✓not a status marker', null],
    ['codex', '✓ Run Orca dispatched worker …', null],
    [null, '✓ Run Orca dispatched worker …', null]
  ] as const)('classifies %s title %s as %s', (agent, title, expected) => {
    expect(hermesNativeTitleStatus(title, agent)).toBe(expected)
  })
})
