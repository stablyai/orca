import { describe, expect, it } from 'vitest'
import {
  claudeBackgroundShellCommandMatches,
  DEFAULT_CLAUDE_BACKGROUND_SHELL_IGNORE_PATTERNS as DEFAULTS,
  normalizeClaudeBackgroundShellIgnorePatterns,
  resolveClaudeBackgroundShellIgnorePatterns
} from './claude-background-shell-patterns'

const matchesDefault = (command: string): boolean =>
  claudeBackgroundShellCommandMatches(command, DEFAULTS)

describe('claudeBackgroundShellCommandMatches', () => {
  it('matches never-ending commands across ecosystems', () => {
    for (const command of [
      'npm run dev',
      'next dev --port 3000',
      'ng serve',
      'python manage.py runserver',
      'tsc --watch',
      'cargo watch -x test',
      'uvicorn app:main --reload',
      'nodemon server.js',
      'tail -f /var/log/app.log',
      'NODE_ENV=development npm run dev'
    ]) {
      expect(matchesDefault(command)).toBe(true)
    }
  })

  it('leaves commands whose result the turn may await alone', () => {
    for (const command of [
      'pytest -q',
      'npm run build',
      'curl -s http://localhost:3000/api/health',
      'go test ./...',
      'docker build -t app .',
      './scripts/api-smoke.sh --json'
    ]) {
      expect(matchesDefault(command)).toBe(false)
    }
  })

  it('matches whole tokens, not substrings', () => {
    expect(claudeBackgroundShellCommandMatches('./dev-check.sh', ['dev'])).toBe(false)
    expect(claudeBackgroundShellCommandMatches('bash dev', ['dev'])).toBe(true)
    // Why: shell quoting must not hide a token behind punctuation.
    expect(claudeBackgroundShellCommandMatches("nginx -g 'daemon off;'", ['off'])).toBe(true)
  })

  it('treats a pattern containing a space as a phrase', () => {
    expect(claudeBackgroundShellCommandMatches('docker compose up', ['compose up'])).toBe(true)
    expect(claudeBackgroundShellCommandMatches('docker compose build', ['compose up'])).toBe(false)
  })

  it('is case-insensitive and ignores non-string or empty input', () => {
    expect(claudeBackgroundShellCommandMatches('NPM RUN DEV', ['dev'])).toBe(true)
    expect(claudeBackgroundShellCommandMatches(undefined, ['dev'])).toBe(false)
    expect(claudeBackgroundShellCommandMatches('npm run dev', [])).toBe(false)
  })
})

describe('normalizeClaudeBackgroundShellIgnorePatterns', () => {
  it('trims, lowercases, dedupes and drops unusable entries', () => {
    expect(
      normalizeClaudeBackgroundShellIgnorePatterns([' Dev ', 'dev', '', '  ', 42, null, 'serve'])
    ).toEqual(['dev', 'serve'])
    expect(normalizeClaudeBackgroundShellIgnorePatterns('nope')).toEqual([])
  })

  it('bounds a pathological list', () => {
    const huge = Array.from({ length: 500 }, (_, i) => `p${i}`)
    expect(normalizeClaudeBackgroundShellIgnorePatterns(huge)).toHaveLength(100)
    expect(normalizeClaudeBackgroundShellIgnorePatterns(['x'.repeat(65)])).toEqual([])
  })
})

describe('resolveClaudeBackgroundShellIgnorePatterns', () => {
  it('applies nothing until the user opts in', () => {
    expect(resolveClaudeBackgroundShellIgnorePatterns(null)).toEqual([])
    expect(
      resolveClaudeBackgroundShellIgnorePatterns({
        agentStatusBackgroundShellIgnorePatterns: ['dev']
      })
    ).toEqual([])
  })

  it('falls back to the built-in list only when the user has none stored', () => {
    expect(
      resolveClaudeBackgroundShellIgnorePatterns({ agentStatusIgnoresBackgroundShells: true })
    ).toEqual([...DEFAULTS])
    expect(
      resolveClaudeBackgroundShellIgnorePatterns({
        agentStatusIgnoresBackgroundShells: true,
        agentStatusBackgroundShellIgnorePatterns: []
      })
    ).toEqual([])
  })
})
