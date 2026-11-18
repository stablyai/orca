import { open, rm } from 'node:fs/promises'
import {
  bestEffortFsyncDirectory,
  discardStage,
  fsyncPath,
  prepareSecureStage,
  publishStagedSecureFile,
  stageSecureFile,
  type SecureWriteOptions,
  type StagedSecureFile
} from './secure-file'

async function stageSecureFileAsync(
  targetPath: string,
  contents: string,
  options: { ownerOnly?: boolean; durable?: boolean }
): Promise<StagedSecureFile> {
  if (process.platform === 'win32') {
    // The ACL addon creates the file synchronously; only the flush waits off the thread.
    const staged = stageSecureFile(targetPath, contents, options.ownerOnly)
    try {
      if (options.durable) {
        await fsyncPath(staged.tmpFile, 'r+')
      }
    } catch (error) {
      discardStage(staged.tmpFile)
      throw error
    }
    return staged
  }
  const { dir, tmpFile } = prepareSecureStage(targetPath)
  try {
    const handle = await open(tmpFile, 'wx', 0o600)
    try {
      await handle.writeFile(contents, 'utf8')
      // The umask can strip bits from the mode but never add them; chmod sets exactly 0o600.
      await handle.chmod(0o600)
      if (options.durable) {
        await handle.sync()
      }
    } finally {
      await handle.close()
    }
    return { tmpFile, dir, restricted: true }
  } catch (error) {
    await rm(tmpFile, { force: true })
    throw error
  }
}

/** `writeSecureFile` without blocking the thread on the staged write or the disk. The
 *  shouldPublish check and the rename still run together, after the staged file is written. */
export async function writeSecureFileAsync(
  targetPath: string,
  contents: string,
  options: SecureWriteOptions & { durable?: boolean } = {}
): Promise<boolean> {
  const staged = await stageSecureFileAsync(targetPath, contents, options)
  let restricted: boolean
  try {
    restricted = publishStagedSecureFile(staged, targetPath, options)
  } catch (error) {
    discardStage(staged.tmpFile)
    throw error
  }
  if (options.durable) {
    await bestEffortFsyncDirectory(staged.dir)
  }
  return restricted
}

export function writeDurableSecureFile(
  targetPath: string,
  contents: string,
  options: SecureWriteOptions = {}
): Promise<boolean> {
  return writeSecureFileAsync(targetPath, contents, { ...options, durable: true })
}
