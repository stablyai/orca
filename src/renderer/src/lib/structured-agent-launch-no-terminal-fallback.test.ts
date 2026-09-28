import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { glob } from 'tinyglobby'

const REPO_ROOT = join(import.meta.dirname, '../../../..')
const THIS_FILE = 'src/renderer/src/lib/structured-agent-launch-no-terminal-fallback.test.ts'

describe('structured launch routing', () => {
  it('has no production path from structured launch to a legacy terminal', async () => {
    const files = await glob(['src/renderer/src/**/*.ts', 'src/renderer/src/**/*.tsx'], {
      cwd: REPO_ROOT,
      ignore: ['**/*.test.ts', '**/*.test.tsx', THIS_FILE]
    })
    const legacyPaths = files.filter((file) => {
      const source = readFileSync(join(REPO_ROOT, file), 'utf8')
      return [
        'legacyFallback:',
        'claimDefinitiveRefusalFallback',
        "'refused-then-legacy'",
        "'deadline-then-legacy'",
        'STRUCTURED_AGENT_LAUNCH_DEADLINE_MS'
      ].some((marker) => source.includes(marker))
    })

    expect(legacyPaths).toEqual([])
  })
})
