import { describe, expect, it } from 'vitest'
import { checkWorkspacePullRequests, type WorkspacePrSnapshot } from './workspace-pr-check'
import { buildLineageChildIndex, type LineageRecords } from './lineage-child-index'
import type { Repo } from '../repository/repo-types'
import { LINEAGE_SCAN_ROW_LIMIT } from '../worktree/lineage/lineage-uncertainty'
import type { WorkspaceLineage, WorktreeLineage } from '../worktree/lineage-types'

const repo = (id: string): Repo => ({
  id,
  path: `/${id}`,
  displayName: id,
  badgeColor: '',
  addedAt: 1,
  gitRemoteIdentity: {
    canonicalKey: `github.com/org/${id}`,
    remoteName: 'origin',
    remoteUrl: ''
  }
})
const Q17 = { forgeHost: 'github.com', owner: 'org', repo: 'q', number: 17 }

/** A lineage record that counts every key enumeration (`for…in`, Object.keys) made of it, the
 *  engine work that happens before any loop body can stop early. Keyed reads are not counted. */
function countedRecord<V>(target: Record<string, V>) {
  const counter = { enumerations: 0 }
  const record = new Proxy(target, {
    ownKeys(t) {
      counter.enumerations++
      return Reflect.ownKeys(t)
    }
  })
  return { record, counter }
}

/** `rows` parent links among the primary project's own checkouts, which no report check walks. */
function primaryProjectLinks(rows: number): Record<string, WorktreeLineage> {
  const links: Record<string, WorktreeLineage> = {}
  for (let i = 0; i < rows; i++) {
    links[`p::/p/c${i}`] = {
      worktreeId: `p::/p/c${i}`,
      worktreeInstanceId: `c${i}`,
      parentWorktreeId: 'p::/p/work',
      parentWorktreeInstanceId: 'work',
      origin: 'cli',
      capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
      createdAt: 1
    }
  }
  return links
}

function snapshot(rows: number) {
  const lineage = countedRecord(primaryProjectLinks(rows)),
    workspace = countedRecord<WorkspaceLineage>({}),
    cross = countedRecord<unknown>({})
  const records: LineageRecords = [lineage.record, workspace.record, cross.record]
  const input: WorkspacePrSnapshot = {
    repos: [repo('p'), repo('q')],
    metadata: () => undefined,
    lineage: lineage.record,
    workspaceLineage: workspace.record,
    crossStoreLineage: cross.record,
    uncertainty: {},
    folders: [],
    primaries: ['p::/p/work']
  }
  const enumerations = () =>
    lineage.counter.enumerations + workspace.counter.enumerations + cross.counter.enumerations
  return { input, records, enumerations }
}

const report = { subject: 'Opened org/q#17', body: '', spec: '', host: 'local' }

describe('a negative completion check enumerates no lineage record it does not need', () => {
  it('reuses a cached overflow index without enumerating any lineage record', () => {
    const { input, records, enumerations } = snapshot(LINEAGE_SCAN_ROW_LIMIT + 10)
    const cached = buildLineageChildIndex(records, LINEAGE_SCAN_ROW_LIMIT)
    expect(cached.overflow).toBe(true)
    const before = enumerations()
    let requests = 0
    const result = checkWorkspacePullRequests(
      {
        ...input,
        childIndex: () => {
          requests++
          return cached
        }
      },
      report
    )
    expect(result).toEqual({ version: 1, state: 'partial', outside: [] })
    expect(requests).toBe(1)
    expect(enumerations() - before).toBe(0)
  })

  it('stops before coverage when the snapshot is already incomplete', () => {
    const { input, enumerations } = snapshot(10)
    let requests = 0
    const result = checkWorkspacePullRequests(
      {
        ...input,
        incomplete: true,
        childIndex: (limit) => {
          requests++
          return buildLineageChildIndex([input.lineage, {}, {}], limit)
        }
      },
      report
    )
    expect(result).toEqual({ version: 1, state: 'partial', outside: [] })
    expect(requests).toBe(0)
    expect(enumerations()).toBe(0)
  })

  it('still warns through a fresh, complete index (control)', () => {
    const { input, records, enumerations } = snapshot(10)
    const result = checkWorkspacePullRequests(
      { ...input, childIndex: (limit) => buildLineageChildIndex(records, limit) },
      report
    )
    expect(result).toEqual({ version: 1, state: 'complete', outside: [Q17] })
    // The one build enumerates each record once; nothing else does.
    expect(enumerations()).toBe(3)
  })
})
