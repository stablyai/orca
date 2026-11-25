import { getRepoIdFromWorktreeId } from '../worktree/id'

/** The raw, workspace-row and cross-store lineage records, in that order. */
export type LineageRecords = readonly [
  Readonly<Record<string, unknown>>,
  Readonly<Record<string, unknown>>,
  Readonly<Record<string, unknown>>
]

/** Child keys of the lineage records grouped by the project each key names. Keys only: rows,
 *  instances and metadata are always read live, so the index can never vouch for an edge. */
export type LineageChildIndex = {
  /** The exact record objects indexed; a snapshot holding any other object must not use it. */
  readonly records: LineageRecords
  /** Every key across the three records, so row limits apply exactly as a full scan would. */
  readonly size: number
  /** Per record: project id → child keys as stored in that record. */
  readonly byProject: readonly ReadonlyMap<string, readonly string[]>[]
  /** Per record: keys that name no project (folders, or malformed keys). */
  readonly unprojected: readonly (readonly string[])[]
}

/** A record key as its lineage node: workspace-row and cross-store keys carry a `worktree:` prefix. */
export const lineageRecordNode = (recordIndex: number, key: string): string =>
  recordIndex === 0 || !key.startsWith('worktree:') ? key : key.slice(9)

/** The project a lineage node names, or undefined for folders and keys without a repo part. */
export function lineageNodeProject(node: string): string | undefined {
  const id = node.startsWith('worktree:') ? node.slice(9) : node
  if (id.startsWith('folder:')) {
    return undefined
  }
  const project = getRepoIdFromWorktreeId(id)
  return project.length < id.length ? project : undefined
}

export function buildLineageChildIndex(records: LineageRecords): LineageChildIndex {
  let size = 0
  const byProject: Map<string, string[]>[] = []
  const unprojected: string[][] = []
  for (let i = 0; i < records.length; i++) {
    const projects = new Map<string, string[]>()
    const loose: string[] = []
    for (const key in records[i]) {
      size++
      const project = lineageNodeProject(lineageRecordNode(i, key))
      if (project === undefined) {
        loose.push(key)
        continue
      }
      const keys = projects.get(project)
      if (keys) {
        keys.push(key)
      } else {
        projects.set(project, [key])
      }
    }
    byProject.push(projects)
    unprojected.push(loose)
  }
  return { records, size, byProject, unprojected }
}

export function indexMatchesRecords(
  index: LineageChildIndex | undefined,
  records: LineageRecords
): index is LineageChildIndex {
  return (
    index !== undefined &&
    index.records[0] === records[0] &&
    index.records[1] === records[1] &&
    index.records[2] === records[2]
  )
}
