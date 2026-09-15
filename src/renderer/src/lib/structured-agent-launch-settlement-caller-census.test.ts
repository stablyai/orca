import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { glob } from 'tinyglobby'

const REPO_ROOT = join(import.meta.dirname, '../../../..')
const CENSUS_FILE = 'src/renderer/src/lib/structured-agent-launch-settlement-caller-census.test.ts'
const LOOP_FILE = 'src/renderer/src/lib/structured-agent-launch-settlement.ts'

// Why: every structured entrypoint reaches the settle loop through the planner, which decided
// its route and delivery mode first. A second caller is a bypass of that decision, not a new
// entrypoint; entrypoints add a plan, never a loop call.
const SETTLE_LOOP_CALLERS = ['src/renderer/src/lib/agent-session-launch-plan.ts']

describe('structured launch settle loop caller census', () => {
  it('pins every production settleStructuredAgentLaunch caller', async () => {
    const files = await glob(['src/**/*.ts', 'src/**/*.tsx'], {
      cwd: REPO_ROOT,
      ignore: ['**/*.test.ts', '**/*.test.tsx', CENSUS_FILE, LOOP_FILE]
    })
    const callers = files
      .filter((file) =>
        readFileSync(join(REPO_ROOT, file), 'utf8').includes('settleStructuredAgentLaunch(')
      )
      .sort()
    expect(callers).toEqual([...SETTLE_LOOP_CALLERS].sort())
  })
})
