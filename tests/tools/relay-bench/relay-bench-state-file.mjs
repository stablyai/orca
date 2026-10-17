// Reads and writes the bench state bundle, which holds a live resume token and device token for a
// real paired desktop. Why this is not a bare writeFileSync: `mode` only applies when the file is
// created, so an existing world-readable state.json would keep its mode; and the default path
// lives under a directory the operator may not have created yet, so the write would throw ENOENT
// *after* the desktop already provisioned the credential, losing it.
import {
  closeSync,
  fchmodSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { dirname } from 'node:path'

export const SECRET_FILE_MODE = 0o600
const GROUP_AND_OTHER_BITS = 0o077
// O_NOFOLLOW is POSIX-only; on Windows the lstat check below is the whole guard.
const NOFOLLOW = constants.O_NOFOLLOW ?? 0

function refuseSymlink(path) {
  let stats
  try {
    stats = lstatSync(path)
  } catch {
    return
  }
  if (!stats.isFile()) {
    throw new Error(
      `refusing to use ${path}: it is a symlink or a special file, not a regular file`
    )
  }
}

export function writeSecretFile(path, contents) {
  // 0700 so a directory this call creates under a shared parent is not traversable by others.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  refuseSymlink(path)
  let fd
  try {
    fd = openSync(
      path,
      // No O_TRUNC: truncating happens only after the descriptor passes the checks below, so a
      // refused file keeps its previous contents.
      constants.O_WRONLY | constants.O_CREAT | NOFOLLOW,
      SECRET_FILE_MODE
    )
  } catch (err) {
    if (err.code === 'ELOOP') {
      throw new Error(`refusing to use ${path}: it is a symlink, not a regular file`)
    }
    throw err
  }
  try {
    const stats = fstatSync(fd)
    if (!stats.isFile()) {
      throw new Error(`refusing to write ${path}: not a regular file`)
    }
    // Before the truncate and write, not after: a pre-existing file owned by someone else would
    // otherwise lose its contents and then fail the chmod, leaving the token readable by its owner.
    if (process.platform !== 'win32' && stats.uid !== process.getuid()) {
      throw new Error(`refusing to write ${path}: owned by another user`)
    }
    if (process.platform !== 'win32' && (stats.mode & GROUP_AND_OTHER_BITS) !== 0) {
      fchmodSync(fd, SECRET_FILE_MODE)
    }
    ftruncateSync(fd, 0)
    writeFileSync(fd, contents)
  } finally {
    closeSync(fd)
  }
}

export function readSecretFile(path) {
  refuseSymlink(path)
  const stats = lstatSync(path)
  // Windows fs modes do not express POSIX permissions, so the check would always fail there.
  if (process.platform !== 'win32' && (stats.mode & GROUP_AND_OTHER_BITS) !== 0) {
    throw new Error(
      `refusing to read ${path}: mode ${(stats.mode & 0o777).toString(8)} is readable beyond you. run: chmod 600 ${path}`
    )
  }
  return readFileSync(path, 'utf8')
}
