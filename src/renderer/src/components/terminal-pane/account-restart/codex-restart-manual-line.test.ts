import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const chipSource = readFileSync(path.join(__dirname, 'CodexRestartChip.tsx'), 'utf8')
const english: { auto: { components: { CodexRestartChip: Record<string, string> } } } = JSON.parse(
  readFileSync(path.join(__dirname, '../../../i18n/locales/en.json'), 'utf8')
)

describe('the manual restart line', () => {
  it('sends the user to a new pane, not back into the shell that keeps the old account', () => {
    // Restarting Codex in this pane's shell reuses its old CODEX_HOME, and after an unknown stop
    // there may be no Codex to exit; a new pane is the route that is on the new account.
    const line = english.auto.components.CodexRestartChip['5b8e1d2f40']
    expect(line).toBe("Can't restart automatically. Close this pane and start Codex in a new one.")
    expect(chipSource).toContain(line)
    expect(line).not.toMatch(/exit codex/i)
  })
})
