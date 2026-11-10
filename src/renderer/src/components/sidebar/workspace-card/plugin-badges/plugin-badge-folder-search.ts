import { joinPath } from '@/lib/path'
import { PATH_EXISTENCE_BATCH_MAX } from '../../../../../../shared/file-access/path-existence-batch'
import {
  PLUGIN_WORKTREE_BADGE_MAX_SEARCHED_FOLDERS,
  type PluginWorktreeBadgeEntry
} from '../../../../../../shared/plugins/contributions/plugin-worktree-badge-contribution'

/** A workspace folder on this computer, or on the SSH target `connectionId` names. */
export type PluginBadgeSearchRoot = { path: string; connectionId: string | null }

const SKIPPED_FOLDER_RE = /^(?:\..*|node_modules)$/

function connectionArgs(root: PluginBadgeSearchRoot): { connectionId?: string } {
  return root.connectionId ? { connectionId: root.connectionId } : {}
}

function childPath(folder: string, name: string): string {
  return folder ? `${folder}/${name}` : name
}

/** Whether each path exists; an unreachable host or refused path reads as a miss. */
async function pathsExist(
  root: PluginBadgeSearchRoot,
  paths: readonly string[]
): Promise<boolean[]> {
  const fs = window.api.fs
  // Why local only: the batch is served by this computer, never over SSH.
  const batch = root.connectionId ? undefined : fs.pathsExist
  if (batch) {
    const batches: string[][] = []
    for (let start = 0; start < paths.length; start += PATH_EXISTENCE_BATCH_MAX) {
      batches.push(paths.slice(start, start + PATH_EXISTENCE_BATCH_MAX))
    }
    const results = await Promise.all(
      batches.map((filePaths) => batch({ filePaths }).catch(() => null))
    )
    return results.flatMap((rows, index) =>
      rows ? rows.map((row) => 'exists' in row && row.exists) : batches[index].map(() => false)
    )
  }
  return Promise.all(
    paths.map((filePath) => fs.pathExists({ filePath, ...connectionArgs(root) }).catch(() => false))
  )
}

async function listSubfolders(root: PluginBadgeSearchRoot, folder: string): Promise<string[]> {
  const entries = await window.api.fs
    .readDir({ dirPath: joinPath(root.path, folder), ...connectionArgs(root) })
    .catch(() => [])
  return entries
    .filter((entry) => entry.isDirectory && !entry.isSymlink && !SKIPPED_FOLDER_RE.test(entry.name))
    .map((entry) => childPath(folder, entry.name))
}

/** Folders, relative to the root with `/` separators (`''` is the root), that hold one of
 *  `pathExists`, searched breadth first down to `searchDepth`. A match's subfolders belong to its
 *  project, so they are not searched. */
export async function findPluginBadgeFolders(
  root: PluginBadgeSearchRoot,
  when: Pick<PluginWorktreeBadgeEntry['when'], 'pathExists' | 'searchDepth'>
): Promise<string[]> {
  const matches: string[] = []
  let level = ['']
  let searched = 1
  for (let depth = 0; level.length > 0; depth++) {
    const markers = level.flatMap((folder) =>
      when.pathExists.map((marker) => joinPath(root.path, childPath(folder, marker)))
    )
    const found = await pathsExist(root, markers)
    const perFolder = when.pathExists.length
    const unmatched = level.filter((folder, index) => {
      const holds = found.slice(index * perFolder, (index + 1) * perFolder).includes(true)
      if (holds) {
        matches.push(folder)
      }
      return !holds
    })
    if (depth >= when.searchDepth) {
      break
    }
    const children = (await Promise.all(unmatched.map((folder) => listSubfolders(root, folder))))
      .flat()
      .slice(0, Math.max(0, PLUGIN_WORKTREE_BADGE_MAX_SEARCHED_FOLDERS - searched))
    searched += children.length
    level = children
  }
  return matches.sort((left, right) => left.localeCompare(right))
}
