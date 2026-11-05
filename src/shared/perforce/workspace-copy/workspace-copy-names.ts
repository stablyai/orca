import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { WorkspaceCopyError } from './workspace-copy-errors'
import { COPY_NAME_PATTERN } from './workspace-copy-name-rules'

// A fixed layout and names, so copies made outside Orca in the same way and Orca's own find each other.
const COPIES_DIR_SUFFIX = '.wt'
const MARKER_SUFFIX = '.p4-worktree.json'

export type WorkspaceCopyNames = {
  name: string
  copiesDir: string
  copyRoot: string
  markerPath: string
  client: string
}

export function assertCopyName(name: string): void {
  if (!COPY_NAME_PATTERN.test(name)) {
    throw new WorkspaceCopyError(
      'usage',
      `Copy names are 1-24 letters, digits or hyphens; '${name}' is not.`
    )
  }
}

/** Turns free text into a copy name; a name that had to be shortened keeps a hash so two never collide. */
export function toCopyName(raw: string): string {
  const clean = raw
    .replace(/[^A-Za-z0-9-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
  if (clean && clean.length <= 24 && clean === raw) {
    return clean
  }
  const hash = createHash('md5').update(raw, 'utf8').digest('hex').slice(0, 8)
  if (!clean) {
    return `wt-${hash}`
  }
  return `${clean.slice(0, 15).replace(/-+$/, '')}-${hash}`
}

export function copyClientPrefix(sourceClient: string): string {
  return `${sourceClient}_wt_`
}

export function copiesDirFor(sourceRoot: string): string {
  const parent = dirname(sourceRoot)
  if (parent === sourceRoot) {
    throw new WorkspaceCopyError(
      'refused',
      `The workspace root ${sourceRoot} is a drive root; put the workspace in a folder so copies can sit beside it.`
    )
  }
  return join(parent, `${basename(sourceRoot)}${COPIES_DIR_SUFFIX}`)
}

export function markerPathFor(copiesDir: string, name: string): string {
  return join(copiesDir, `${name}${MARKER_SUFFIX}`)
}

export function copyNameFromMarkerFile(fileName: string): string | null {
  if (!fileName.endsWith(MARKER_SUFFIX)) {
    return null
  }
  const name = fileName.slice(0, -MARKER_SUFFIX.length)
  return COPY_NAME_PATTERN.test(name) ? name : null
}

/** The marker path a copy rooted at `root` would have, or null when `root` is not inside a `.wt` folder. */
export function ownMarkerPathCandidate(root: string): string | null {
  const parent = dirname(root)
  if (parent === root || !basename(parent).toLowerCase().endsWith(COPIES_DIR_SUFFIX)) {
    return null
  }
  return join(parent, `${basename(root)}${MARKER_SUFFIX}`)
}

export function copyNamesFor(
  source: { client: string; root: string; stream: string | null },
  name: string
): WorkspaceCopyNames {
  assertCopyName(name)
  const copiesDir = copiesDirFor(source.root)
  return {
    name,
    copiesDir,
    copyRoot: join(copiesDir, name),
    markerPath: markerPathFor(copiesDir, name),
    client: `${copyClientPrefix(source.client)}${name}`
  }
}
