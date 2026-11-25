// Persist live desktop resume/device credentials: create parents before writing and force permissions on existing files too.
// writeFileSync mode only governs creation; ENOENT after provisioning would lose the already-issued credential.
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
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
  mkdirSync(dirname(path), { recursive: true })
  refuseSymlink(path)
  let fd
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NOFOLLOW,
      SECRET_FILE_MODE
    )
  } catch (err) {
    if (err.code === 'ELOOP') {
      throw new Error(`refusing to use ${path}: it is a symlink, not a regular file`)
    }
    throw err
  }
  try {
    if (!fstatSync(fd).isFile()) {
      throw new Error(`refusing to write ${path}: not a regular file`)
    }
    writeFileSync(fd, contents)
  } finally {
    closeSync(fd)
  }
  // Fail closed rather than silently leaving a pre-existing 0644 file readable.
  chmodSync(path, SECRET_FILE_MODE)
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
