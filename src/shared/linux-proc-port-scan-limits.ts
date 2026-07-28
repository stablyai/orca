import { readNodeFileWithinLimit } from './node-bounded-file-reader'

export const LINUX_PROC_NETWORK_TABLE_MAX_BYTES = 8 * 1024 * 1024
export const LINUX_PROC_LISTENING_SOCKET_MAX_ENTRIES = 2_048
export const LINUX_PROC_PROCESS_METADATA_MAX_BYTES = 8 * 1024 * 1024
export const LINUX_PROC_PROCESS_METADATA_FILE_MAX_BYTES = 64 * 1024

export type LinuxProcTextReadBudget = { remainingBytes: number }

type LinuxProcTextReader = (filePath: string, maxBytes: number) => Promise<Buffer>

const readBoundedNodeFile: LinuxProcTextReader = async (filePath, maxBytes) =>
  (await readNodeFileWithinLimit(filePath, maxBytes)).buffer

export function createLinuxProcTextReadBudget(
  maxBytes = LINUX_PROC_PROCESS_METADATA_MAX_BYTES
): LinuxProcTextReadBudget {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('Linux proc text budget must be a non-negative safe integer')
  }
  return { remainingBytes: maxBytes }
}

export async function readLinuxProcNetworkTable(
  filePath: string,
  readFile: LinuxProcTextReader = readBoundedNodeFile
): Promise<string | null> {
  try {
    return (await readFile(filePath, LINUX_PROC_NETWORK_TABLE_MAX_BYTES)).toString('utf8')
  } catch {
    return null
  }
}

export async function readLinuxProcTextWithinBudget(
  filePath: string,
  budget: LinuxProcTextReadBudget,
  readFile: LinuxProcTextReader = readBoundedNodeFile,
  perFileMaxBytes = LINUX_PROC_PROCESS_METADATA_FILE_MAX_BYTES
): Promise<string | undefined> {
  const maxBytes = Math.min(perFileMaxBytes, budget.remainingBytes)
  if (maxBytes <= 0) {
    return undefined
  }
  try {
    const content = await readFile(filePath, maxBytes)
    if (content.byteLength > maxBytes) {
      return undefined
    }
    budget.remainingBytes -= content.byteLength
    return content.toString('utf8')
  } catch {
    return undefined
  }
}
