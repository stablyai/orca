import { describe, expect, it } from 'vitest'
import { suggestedRunCommands } from './use-cloud-suggested-run-commands'

const host = { hostId: 'runtime:env' as const, label: 'Orca Cloud' }
const lines = (text: string): string[] =>
  suggestedRunCommands(text, host).map((entry) =>
    'command' in entry.command ? entry.command.command : ''
  )

describe('cloud Run menu suggestions (JA-31)', () => {
  it('suggests test, typecheck, lint, build, dev from package.json, in that order', () => {
    const pkg = JSON.stringify({
      scripts: { dev: 'vite', lint: 'eslint .', typecheck: 'tsc', test: 'vitest', other: 'x' }
    })
    expect(lines(pkg)).toEqual(['npm run test', 'npm run typecheck', 'npm run lint', 'npm run dev'])
    expect(suggestedRunCommands(pkg, host).every((entry) => entry.suggested)).toBe(true)
  })

  it('uses the package manager the project declares', () => {
    expect(
      lines(JSON.stringify({ packageManager: 'pnpm@9.1.0', scripts: { test: 'vitest' } }))
    ).toEqual(['pnpm test'])
  })

  it('suggests nothing for a missing, broken or script-less package.json', () => {
    expect(lines('not json')).toEqual([])
    expect(lines(JSON.stringify({ name: 'x' }))).toEqual([])
    expect(lines(JSON.stringify({ scripts: [] }))).toEqual([])
  })
})
