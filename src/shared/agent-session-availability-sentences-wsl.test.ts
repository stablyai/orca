import { expect, it } from 'vitest'
import { cliMissingSentence } from './agent-session-availability-sentences'
import { sayAgentSessionFailureEnglish } from './agent-session-failure-copy'

it('names the WSL distro an agent is missing from, keeping the command retry', () => {
  expect(
    cliMissingSentence(
      { agentName: 'Codex', wslDistro: 'Debian', command: 'compact' },
      sayAgentSessionFailureEnglish
    )
  ).toBe(
    "Codex isn't installed in the WSL distro Debian. Install it inside Debian, or check its Command in Settings → Agents. Run /compact again."
  )
})

it('keeps "the computer running this chat" off a WSL host', () => {
  expect(cliMissingSentence({ agentName: 'Codex' }, sayAgentSessionFailureEnglish)).toBe(
    "Codex wasn't found on the computer running this chat. Install it, or check its Command in Settings → Agents."
  )
})
