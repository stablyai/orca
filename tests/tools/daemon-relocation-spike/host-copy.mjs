// Copy each tier under daemon-host/ with require/native-relative paths preserved; return launch paths.

import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { HOST_EXE } from './app-inventory.mjs'
import { toPosixRelative } from './tier-file-set.mjs'

export const HOST_SUBDIR = 'daemon-host'

function destPath(hostRoot, destRel) {
  return join(hostRoot, ...destRel.split('/'))
}

// Return copied host/entry/native paths and skipped inputs. nodePtyNativeDir supports builds reading ORCA_NODE_PTY_NATIVE_DIR; current patch ignores it.
export function copyHost(inv, plan, workDir) {
  const hostRoot = join(workDir, HOST_SUBDIR)
  mkdirSync(hostRoot, { recursive: true })

  const skipped = []
  for (const op of plan.ops) {
    const dest = destPath(hostRoot, op.destRel)
    if (!existsSync(op.sourcePath)) {
      if (!op.optional) {
        skipped.push(op.destRel)
      }
      continue
    }
    mkdirSync(dirname(dest), { recursive: true })
    // Dereference symlinks so copied files cannot retain links into the install.
    cpSync(op.sourcePath, dest, {
      recursive: op.kind === 'dir',
      dereference: true,
      force: true
    })
  }

  const hostExePath = join(hostRoot, HOST_EXE)
  const daemonEntryPath = inv.daemonEntry.exists
    ? destPath(hostRoot, toPosixRelative(inv.appDir, inv.daemonEntry.path))
    : ''

  let nodePtyNativeDir = ''
  if (inv.nodePty.exists && inv.nodePty.nativeRel) {
    const pkgRel = toPosixRelative(inv.appDir, inv.nodePty.packageDir)
    nodePtyNativeDir = destPath(hostRoot, `${pkgRel}/${inv.nodePty.nativeRel}`)
  }

  return { hostRoot, hostExePath, daemonEntryPath, nodePtyNativeDir, skipped }
}
