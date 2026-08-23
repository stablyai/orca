import { mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeProbeScratchDirectory } from './probe-scratch-directory'

/** Whether this process may create symbolic links, asked by trying.
 *
 *  Windows refuses `CreateSymbolicLink` unless the process is elevated or
 *  Developer Mode is on, so the answer varies between two machines running the
 *  same build — and a CI runner, which is elevated, can do what a developer's
 *  desktop cannot.
 *
 *  Tests gate on this rather than on `process.platform` for exactly that
 *  reason: a platform check would keep the test skipped on the runner where it
 *  would have run, which is the one place the coverage was worth having.
 *
 *  Directory links are asked separately because Windows offers junctions, which
 *  need no privilege at all and are what production reaches for first. */

type LinkKind = 'file' | 'junction'

const answers = new Map<LinkKind, boolean>()

function probe(kind: LinkKind): boolean {
  // Why a scratch directory rather than a fixed path: the suite runs many
  // workers at once, and two of them racing on one link name would answer the
  // question wrongly for whichever lost.
  let directory: string | null = null
  try {
    directory = mkdtempSync(join(tmpdir(), 'orca-symlink-probe-'))
    // A junction must point at a directory; a file link may dangle, and a
    // dangling one still proves the privilege.
    const target = kind === 'junction' ? directory : join(directory, 'absent-target')
    symlinkSync(target, join(directory, 'probe-link'), kind)
    return true
  } catch {
    return false
  } finally {
    if (directory) {
      removeProbeScratchDirectory(directory)
    }
  }
}

function cached(kind: LinkKind): boolean {
  const known = answers.get(kind)
  if (known !== undefined) {
    return known
  }
  const answer = probe(kind)
  answers.set(kind, answer)
  return answer
}

/** The `fs.symlink` type that links a directory on this platform.
 *
 *  A junction needs no privilege, which is why production reaches for it first
 *  and why a directory link is a fix rather than something to skip. POSIX
 *  ignores the argument, so `'dir'` is only ever documentation there. */
export function directoryLinkType(): 'junction' | 'dir' {
  return process.platform === 'win32' ? 'junction' : 'dir'
}

/** True when a link to a file can be created here. */
export function canCreateFileSymlink(): boolean {
  return cached('file')
}

/** True when a link to a directory can be created here.
 *
 *  On Windows this asks about a junction, which is what production creates
 *  first and which needs no privilege — so this is usually true where
 *  `canCreateFileSymlink` is false. */
export function canCreateDirectorySymlink(): boolean {
  return process.platform === 'win32' ? cached('junction') : cached('file')
}
