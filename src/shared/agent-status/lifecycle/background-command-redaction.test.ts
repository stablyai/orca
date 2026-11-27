import { describe, expect, it } from 'vitest'
import { readClaudeBackgroundAgentTasks } from '../../agent-hook-listener/providers/claude/background-tasks/claude-background-task-inventory'
import { childWorkBackgroundCommands } from './agent-background-wait'

const GITHUB_TOKEN = `ghp_${'a'.repeat(36)}`
const FINE_GRAINED_TOKEN = `github_pat_${'b'.repeat(22)}_${'c'.repeat(59)}`
const SECRET_COMMANDS = [
  'curl -H "Authorization: Bearer sekret123" https://api.example.com',
  'deploy --token=sekret123',
  'API_KEY=sekret123 node server.js',
  `git clone https://${GITHUB_TOKEN}@github.com/org/repo`,
  `gh auth login --with-token <<< ${FINE_GRAINED_TOKEN}`
]

// Both producers feed a status row's backgroundCommands, which worker status, the CLI and the DB show.
describe('background command redaction', () => {
  it('redacts credentials in Claude background shells and chat child work, keeping plain commands', () => {
    const claudeCommand = (command: string): string | undefined =>
      readClaudeBackgroundAgentTasks({
        background_tasks: [{ id: 'b1', type: 'local_bash', status: 'running', command }]
      }).runningNonAgentTaskCommands[0]
    const chatCommand = (input: string): string | undefined =>
      childWorkBackgroundCommands([
        {
          kind: 'command',
          state: 'working',
          membership: 'live',
          operation: { toolName: 'Bash', input, basis: 'open', observedAt: 0 }
        }
      ])?.[0]

    for (const read of [claudeCommand, chatCommand]) {
      for (const secret of SECRET_COMMANDS) {
        const shown = read(secret)
        expect(shown).toContain('[redacted')
        expect(shown).not.toContain('sekret123')
        expect(shown).not.toContain(GITHUB_TOKEN)
        expect(shown).not.toContain(FINE_GRAINED_TOKEN.slice(11))
      }
      expect(read('npm run dev')).toBe('npm run dev')
    }
  })
})
