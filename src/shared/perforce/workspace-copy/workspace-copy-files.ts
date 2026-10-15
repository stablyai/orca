import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { pathExists } from './workspace-copy-source'

// Per-machine runtime state a running editor owns; copying it would hand the copy a torn or locked project.
const UNITY_RUNTIME_FOLDERS = ['Temp', 'Logs', 'obj']
const UNITY_EDITOR_LOCK_FILES = [
  'ArtifactDB-lock',
  'SourceAssetDB-lock',
  'ilpp.pid',
  'EditorInstance.json'
]
const NO_PROJECT_SEARCH = new Set([
  'assets',
  'library',
  'packages',
  'temp',
  'logs',
  'obj',
  'node_modules',
  '.git',
  '.vs',
  '.idea'
])

/** Unity projects (folders with ProjectSettings/ProjectVersion.txt) up to three levels below `root`. */
export async function findUnityProjects(root: string, maxDepth = 3): Promise<string[]> {
  const projects: string[] = []
  let level = [root]
  for (let depth = 0; depth <= maxDepth && level.length > 0; depth += 1) {
    const next: string[] = []
    for (const dir of level) {
      if (await pathExists(join(dir, 'ProjectSettings', 'ProjectVersion.txt'))) {
        projects.push(dir)
        continue
      }
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (entry.isDirectory() && !NO_PROJECT_SEARCH.has(entry.name.toLowerCase())) {
          next.push(join(dir, entry.name))
        }
      }
    }
    level = next
  }
  return projects
}

/**
 * Full paths, never bare names: robocopy applies a bare /XD name at every depth, which would also
 * drop an Assets subfolder that happens to be called Temp.
 */
export function excludedFolders(
  root: string,
  projects: readonly string[],
  options: {
    skipPackageCache?: boolean
    extraExcludedFolders?: readonly string[]
  }
): string[] {
  const folders = (options.extraExcludedFolders ?? [])
    .map((folder) => folder.trim().replace(/^[\\/]+|[\\/]+$/g, ''))
    .filter(Boolean)
    .map((folder) => join(root, folder))
  for (const project of projects) {
    folders.push(...UNITY_RUNTIME_FOLDERS.map((name) => join(project, name)))
    if (options.skipPackageCache) {
      folders.push(join(project, 'Library', 'PackageCache'))
    }
  }
  return folders
}

export function excludedFiles(projects: readonly string[]): string[] {
  return projects.flatMap((project) =>
    UNITY_EDITOR_LOCK_FILES.map((name) => join(project, 'Library', name))
  )
}

/** Keeps timestamps (Unity decides what to reimport from them); on ReFS each file is block-cloned. */
export function robocopyArguments(
  source: string,
  destination: string,
  folders: readonly string[],
  files: readonly string[]
): string[] {
  const args = [source, destination, '/E', '/COPY:DAT', '/DCOPY:DAT', '/MT:32', '/R:1', '/W:1']
  args.push('/NFL', '/NDL', '/NP', '/BYTES')
  if (folders.length > 0) {
    args.push('/XD', ...folders)
  }
  if (files.length > 0) {
    args.push('/XF', ...files)
  }
  return args
}

/** robocopy exit codes 0-7 are success; 8 and up mean at least one file failed. */
export function robocopyFailed(code: number | null): boolean {
  return code === null || code >= 8
}

/**
 * Copied files and bytes from robocopy's summary. With /BYTES its Dirs, Files and Bytes rows are six
 * plain integers each (the labels are localized, the shape is not); Copied is the second column.
 */
export function parseRobocopySummary(stdout: string): { files: number; bytes: number } | null {
  const rows = stdout
    .split(/\r?\n/)
    .map((line) => /^\s*[^:\d]+:\s+(\d+)\s+(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s*$/.exec(line))
    .filter((match) => match !== null)
  if (rows.length < 3) {
    return null
  }
  return { files: Number(rows.at(-2)?.[2]), bytes: Number(rows.at(-1)?.[2]) }
}

export function relativeTo(root: string, path: string): string {
  return relative(root, path).replaceAll('\\', '/')
}
