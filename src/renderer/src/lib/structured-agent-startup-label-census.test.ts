import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { glob } from 'tinyglobby'

const REPO_ROOT = join(import.meta.dirname, '../../../..')

describe('structured launch copy', () => {
  it('never exposes the removed starting-chat phase or label', async () => {
    const files = await glob(
      ['src/renderer/src/**/*.ts', 'src/renderer/src/**/*.tsx', 'src/renderer/src/i18n/**/*.json'],
      {
        cwd: REPO_ROOT,
        ignore: ['**/*.test.ts', '**/*.test.tsx']
      }
    )
    const offenders = files.filter((file) => {
      const source = readFileSync(join(REPO_ROOT, file), 'utf8')
      return (
        source.includes('starting-chat') ||
        source.includes('Starting chat…') ||
        /Starting (?:\{\{value0\}\}|Claude|Codex) chat…/.test(source)
      )
    })

    expect(offenders).toEqual([])
  })
})
