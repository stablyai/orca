import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const FLOW_SOURCE = readFileSync(join(__dirname, 'worktree-creation-flow-execute.ts'), 'utf8')

function sourceBetween(source: string, startPattern: string, endPattern: string): string {
  const start = source.indexOf(startPattern)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(endPattern, start + startPattern.length)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('worktree creation flow agent trust preflight', () => {
  it('forwards the repo SSH connection id when pre-marking agent trust', () => {
    const preflight = sourceBetween(
      FLOW_SOURCE,
      'async function preflightAgentTrust',
      'async function executeWorktreeCreation'
    )
    const createFlow = sourceBetween(
      FLOW_SOURCE,
      'const backendSpawned = result.startupTerminal?.spawned === true',
      '// `createWorktree` already inserted the real worktree row'
    )

    expect(preflight).toContain('connectionId?: string | null')
    expect(preflight).toContain('...(connectionId ? { connectionId } : {})')
    expect(createFlow).toContain('repoConnectionId')
    expect(createFlow).toContain('repo.id === worktree.repoId')
    expect(createFlow).toContain(
      'await preflightAgentTrust(preparedRequest, worktree.path, repoConnectionId)'
    )
  })
})
