import { describe, expect, it, vi } from 'vitest'
import type { GitHistoryExecutor } from './git-history'
import {
  GIT_HISTORY_MAX_LIMIT,
  loadGitHistoryFromExecutor,
  parseGitHistoryLog
} from './git-history'
import { GIT_HISTORY_COMMIT_FORMAT } from './git-history-log-parser'

const HEAD_OID = 'a'.repeat(40)
const REMOTE_OID = 'b'.repeat(40)
const BASE_OID = 'c'.repeat(40)
const DECORATION_SEPARATOR = '\x1f'

function logRecord({
  hash,
  parents = [],
  decorations = '',
  message,
  author = 'Ada Lovelace',
  timestamp = 1_700_000_000
}: {
  hash: string
  parents?: string[]
  decorations?: string
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
    message
  ].join('\n')}\0`
}

function createHistoryExecutor(limitRecords = 2): {
  executor: GitHistoryExecutor
  calls: string[][]
} {
  const calls: string[][] = []
  const executor = vi.fn(async (args: string[], cwd: string) => {
    expect(cwd).toBe('/repo')
    calls.push(args)
    const command = args[0]

    if (command === 'rev-parse' && args.includes('HEAD^{commit}')) {
      return { stdout: `${HEAD_OID}\n` }
    }
    if (command === 'rev-parse' && args.includes('refs/remotes/origin/feature^{commit}')) {
      return { stdout: `${REMOTE_OID}\n` }
    }
    if (command === 'symbolic-ref') {
      return { stdout: 'feature\n' }
    }
    if (command === 'for-each-ref') {
      return { stdout: 'refs/remotes/origin/feature\0origin/feature\n' }
    }
    if (command === 'merge-base') {
      return { stdout: `${BASE_OID}\n` }
    }
    if (command === 'log') {
      const includesRemoteRoot = args.includes(REMOTE_OID)
      return {
        stdout: Array.from({ length: limitRecords }, (_, index) =>
          logRecord({
            hash:
              index === 0
                ? HEAD_OID
                : includesRemoteRoot && index === 1
                  ? REMOTE_OID
                  : (index % 16).toString(16).repeat(40),
            parents: [BASE_OID],
            decorations: index === 0 ? 'HEAD -> refs/heads/feature' : '',
            message: `commit ${index}`
          })
        ).join('')
      }
    }

    throw new Error(`unexpected git command: ${args.join(' ')}`)
  })

  return { executor, calls }
}

describe('git history parsing', () => {
  it('parses VS Code-compatible git log records with decorations and multiline messages', () => {
    const stdout = logRecord({
      hash: HEAD_OID,
      parents: [BASE_OID],
      decorations:
        'HEAD -> refs/heads/feature, refs/remotes/origin/HEAD -> refs/remotes/origin/feature, refs/remotes/origin/feature, tag: refs/tags/v1.0.0',
      message: 'feat: add graph\n\nbody line'
    })

    const [item] = parseGitHistoryLog(stdout)

    expect(item).toMatchObject({
      id: HEAD_OID,
      parentIds: [BASE_OID],
      subject: 'feat: add graph',
      message: 'feat: add graph\n\nbody line',
      author: 'Ada Lovelace',
      authorEmail: 'ada@example.com',
      displayId: HEAD_OID.slice(0, 7)
    })
    expect(item?.references?.map((ref) => [ref.id, ref.name, ref.category])).toEqual([
      ['refs/heads/feature', 'feature', 'branches'],
      ['refs/remotes/origin/feature', 'origin/feature', 'remote branches'],
      ['refs/tags/v1.0.0', 'v1.0.0', 'tags']
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
  it('uses one bounded topo-order log query for the graph data', async () => {
    const { executor, calls } = createHistoryExecutor()

    const result = await loadGitHistoryFromExecutor(executor, '/repo', { limit: 50 })

    const logCall = calls.find((args) => args[0] === 'log')
    expect(logCall).toEqual(
      expect.arrayContaining([
        `--format=${GIT_HISTORY_COMMIT_FORMAT}`,
        '-z',
        '--topo-order',
        '--decorate=full',
        '-n51',
        HEAD_OID
      ])
    )
    expect(logCall).not.toContain(REMOTE_OID)
    expect(calls.filter((args) => args[0] === 'log')).toHaveLength(1)
    expect(result.items).toHaveLength(2)
    expect(result.items.map((item) => item.id)).not.toContain(REMOTE_OID)
    expect(result.hasIncomingChanges).toBe(true)
    expect(result.hasOutgoingChanges).toBe(true)
    expect(result.mergeBase).toBe(BASE_OID)
  })

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
        return { stdout: 'old-workspace\n' }
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

  it('clamps oversized limits before shelling out to git log', async () => {
    const { executor, calls } = createHistoryExecutor(GIT_HISTORY_MAX_LIMIT + 1)

    const result = await loadGitHistoryFromExecutor(executor, '/repo', { limit: 500 })

    const logCall = calls.find((args) => args[0] === 'log')
    expect(logCall).toContain(`-n${GIT_HISTORY_MAX_LIMIT + 1}`)
    expect(result.items).toHaveLength(GIT_HISTORY_MAX_LIMIT)
    expect(result.limit).toBe(GIT_HISTORY_MAX_LIMIT)
    expect(result.hasMore).toBe(true)
  })

  it('returns an empty result for unborn repositories without running git log', async () => {
    const executor = vi.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse') {
        throw new Error('ambiguous argument HEAD')
      }
      throw new Error(`unexpected git command: ${args.join(' ')}`)
    })

    const result = await loadGitHistoryFromExecutor(executor, '/repo')

    expect(result).toMatchObject({
      items: [],
      hasIncomingChanges: false,
      hasOutgoingChanges: false,
      hasMore: false
    })
    expect(executor).toHaveBeenCalledTimes(1)
  })
})
