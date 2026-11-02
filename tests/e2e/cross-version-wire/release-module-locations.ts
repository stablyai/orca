import { existsSync, readdirSync } from 'node:fs'
import { join, posix } from 'node:path'

export type ReleaseTree = {
  exists: (rootRelativePath: string) => boolean
  /** Root-relative forward-slash paths of every file under `directory`. */
  list: (directory: string) => readonly string[]
}

const listings = new Map<string, readonly string[]>()

function checkoutTree(root: string): ReleaseTree {
  return {
    exists: (path) => existsSync(join(root, path)),
    list: (directory) => {
      const key = join(root, directory)
      let files = listings.get(key)
      if (!files) {
        files = existsSync(key)
          ? readdirSync(key, { recursive: true, encoding: 'utf8' }).map((entry) =>
              posix.join(directory, entry.split('\\').join('/'))
            )
          : []
        listings.set(key, files)
      }
      return files
    }
  }
}

/**
 * Where the release under `root` defines the module a suite names. Suites name main's path; a
 * release cut before a folder move ships the module elsewhere under the same source root, so the
 * one file there with its name is that module. Missing or ambiguous names pass through and fail
 * at import, naming the path the suite asked for.
 */
export function releaseModuleLocation(
  root: string,
  rootRelativePath: string,
  tree: ReleaseTree = checkoutTree(root)
): string {
  const named = rootRelativePath
    .replace(/^[/\\]+/, '')
    .split('\\')
    .join('/')
  const sourceRoot = named.split('/').slice(0, 2).join('/')
  if (tree.exists(named) || !sourceRoot.startsWith('src/')) {
    return named
  }
  const name = posix.basename(named)
  const moved = tree.list(sourceRoot).filter((path) => posix.basename(path) === name)
  return moved.length === 1 ? moved[0]! : named
}
