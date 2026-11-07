import { describe, expect, it, vi } from 'vitest'
import type { GitHistoryExecutor } from './git-history-types'
import { loadGitHistoryFromExecutor } from './git-history-execution'
import { parseGitHistoryLog } from './git-history-log-parser'

const HEAD_OID = 'a'.repeat(40)
const REMOTE_OID = 'b'.repeat(40)
const DECORATION_SEPARATOR = '\x1f'

function logRecord({
  hash,
  parents = [],
  decorations = '',
  legacyDecorations = '',
  message,
  author = 'Ada Lovelace',
  timestamp = 1_700_000_000
}: {
  hash: string
  parents?: string[]
  decorations?: string
  legacyDecorations?: string
  message: string
  author?: string
  timestamp?: number
}): string {
  return `${[
    hash,
    author,
    'ada@example.com',
    String(timestamp),
    String(timestamp),
    parents.join(' '),
    decorations,
    legacyDecorations,
    message
  ].join('\n')}\0`
}

describe('git history parsing', () => {
  it('falls back to %D decorations when Git predates the %(decorate:…) placeholder', () => {
    // Why: Git < 2.43 echoes the placeholder and exits zero (#15507).
    const stdout = logRecord({
      hash: HEAD_OID,
      decorations: `%(decorate:prefix=,suffix=,separator=${DECORATION_SEPARATOR})`,
      legacyDecorations: 'HEAD -> refs/heads/feature, tag: refs/tags/v1.0.0',
      message: 'feat: add graph'
    })

    const [item] = parseGitHistoryLog(stdout)

    expect(item?.subject).toBe('feat: add graph')
    expect(item?.references?.map((ref) => [ref.id, ref.name, ref.category])).toEqual([
      ['refs/heads/feature', 'feature', 'branches'],
      ['refs/tags/v1.0.0', 'v1.0.0', 'tags']
    ])
  })

  it('preserves commas in legacy branch, remote, and tag decorations', () => {
    const [item] = parseGitHistoryLog(
      logRecord({
        hash: HEAD_OID,
        decorations: `%(decorate:prefix=,suffix=,separator=${DECORATION_SEPARATOR})`,
        message: 'preserve legacy ref names',
        legacyDecorations: [
          'HEAD -> refs/heads/feat,,one',
          'refs/remotes/origin/feat,one',
          'tag: refs/tags/v1,,0'
        ].join(', ')
      })
    )

    expect(item?.references?.map((ref) => [ref.id, ref.name, ref.category])).toEqual([
      ['refs/heads/feat,,one', 'feat,,one', 'branches'],
      ['refs/remotes/origin/feat,one', 'origin/feat,one', 'remote branches'],
      ['refs/tags/v1,,0', 'v1,,0', 'tags']
    ])
  })

  it('keeps a comma inside a lone decoration, which carries no separator', () => {
    // Why: a lone decoration carries no separator, so sniffing for \x1f split it in two.
    const stdout = logRecord({
      hash: HEAD_OID,
      decorations: 'HEAD -> refs/heads/feat,one',
      message: 'initial'
    })

    const [item] = parseGitHistoryLog(stdout)

    expect(item?.references?.map((ref) => [ref.id, ref.name])).toEqual([
      ['refs/heads/feat,one', 'feat,one']
    ])
  })

  it('preserves commas inside branch and tag decoration names', () => {
    const stdout = logRecord({
      hash: HEAD_OID,
      decorations: ['HEAD -> refs/heads/feat,one', 'tag: refs/tags/v1,0', 'refs/heads/master'].join(
        DECORATION_SEPARATOR
      ),
      message: 'initial'
    })

    const [item] = parseGitHistoryLog(stdout)

    expect(item?.references?.map((ref) => [ref.id, ref.name, ref.category])).toEqual([
      ['refs/heads/feat,one', 'feat,one', 'branches'],
      ['refs/heads/master', 'master', 'branches'],
      ['refs/tags/v1,0', 'v1,0', 'tags']
    ])
  })
})

describe('git history loader', () => {
  it('does not list newly fetched upstream commits in old workspace history', async () => {
    const upstreamOnlyOid = 'd'.repeat(40)
    const calls: string[][] = []
    const executor = vi.fn(async (args: string[], cwd: string) => {
      expect(cwd).toBe('/repo')
      calls.push(args)
      const command = args[0]

      if (command === 'rev-parse' && args.includes('HEAD^{commit}')) {
        return { stdout: `${HEAD_OID}\n` }
      }
      if (command === 'rev-parse' && args.includes('refs/remotes/origin/main^{commit}')) {
        return { stdout: `${REMOTE_OID}\n` }
      }
      if (command === 'rev-parse' && args.includes('origin/main^{commit}')) {
        return { stdout: `${REMOTE_OID}\n` }
      }
      if (command === 'rev-parse' && args.includes('origin/main')) {
        return { stdout: 'refs/remotes/origin/main\n' }
      }
      if (command === 'symbolic-ref') {
        return { stdout: 'refs/heads/old-workspace\n' }
      }
      if (command === 'for-each-ref') {
        return { stdout: 'refs/remotes/origin/main\0origin/main\n' }
      }
      if (command === 'merge-base') {
        return { stdout: `${HEAD_OID}\n` }
      }
      if (command === 'log') {
        const includesRemoteRoot = args.includes(REMOTE_OID)
        return {
          stdout: includesRemoteRoot
            ? [
                logRecord({
                  hash: upstreamOnlyOid,
                  parents: [REMOTE_OID],
                  message: 'new upstream commit'
                }),
                logRecord({
                  hash: HEAD_OID,
                  decorations: 'HEAD -> refs/heads/old-workspace',
                  message: 'old workspace base'
                })
              ].join('')
            : logRecord({
                hash: HEAD_OID,
                decorations: 'HEAD -> refs/heads/old-workspace',
                message: 'old workspace base'
              })
        }
      }

      throw new Error(`unexpected git command: ${args.join(' ')}`)
    })

    const result = await loadGitHistoryFromExecutor(executor, '/repo', {
      limit: 50,
      baseRef: 'origin/main'
    })

    const logCall = calls.find((args) => args[0] === 'log')
    expect(logCall).not.toContain(REMOTE_OID)
    expect(result.remoteRef?.revision).toBe(REMOTE_OID)
    expect(result.baseRef).toBeUndefined()
    expect(result.hasIncomingChanges).toBe(true)
    expect(result.hasOutgoingChanges).toBe(false)
    expect(result.items.map((item) => item.id)).toEqual([HEAD_OID])
  })
})

describe('symbolic full-name resolution', () => {
  // --symbolic-full-name echoes --end-of-options (unlike --verify); treating it as the ref misclassified branches/tags as commits.
  function executorEmitting(symbolicStdout: string): GitHistoryExecutor {
    return vi.fn<GitHistoryExecutor>(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args.includes('--symbolic-full-name')) {
        return { stdout: symbolicStdout }
      }
      if (args[0] === 'rev-parse') {
        return { stdout: `${HEAD_OID}\n` }
      }
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'refs/heads/main\n' }
      }
      if (args[0] === 'for-each-ref' || args[0] === 'merge-base') {
        return { stdout: '' }
      }
      if (args[0] === 'log') {
        return { stdout: logRecord({ hash: HEAD_OID, message: 'only' }) }
      }
      return { stdout: '' }
    })
  }

  it('categorizes a branch when git echoes the option marker', async () => {
    const executor = executorEmitting('--end-of-options\nrefs/heads/feature\n')

    const result = await loadGitHistoryFromExecutor(executor, '/repo', { baseRef: 'feature' })

    expect(result.baseRef).toMatchObject({
      id: 'refs/heads/feature',
      name: 'feature',
      category: 'branches'
    })
  })
})
