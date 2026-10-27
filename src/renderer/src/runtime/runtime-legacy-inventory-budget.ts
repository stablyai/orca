import type { RuntimeFileListEntry, RuntimeFileListResult } from '../../../shared/runtime-types'
import {
  FILE_INVENTORY_MAX_BYTES,
  FILE_INVENTORY_MAX_PATH_BYTES,
  FileInventoryCapacityError
} from '../../../shared/file-inventory-budget'
import { isUtf8ByteLengthWithinLimit } from '../../../shared/utf8-byte-limits'

export function decodeLegacyQuickOpenInventory(
  value: unknown,
  maxBytes = FILE_INVENTORY_MAX_BYTES
): { result: RuntimeFileListResult; retainedBytes: number } {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('files' in value) ||
    !Array.isArray(value.files) ||
    !('worktree' in value) ||
    typeof value.worktree !== 'string' ||
    !('rootPath' in value) ||
    typeof value.rootPath !== 'string' ||
    !('totalCount' in value) ||
    typeof value.totalCount !== 'number' ||
    !Number.isSafeInteger(value.totalCount) ||
    value.totalCount < value.files.length ||
    !('truncated' in value) ||
    typeof value.truncated !== 'boolean'
  ) {
    throw new Error('Invalid remote file inventory')
  }
  let retainedBytes = 128 + (value.worktree.length + value.rootPath.length) * 2
  const files: RuntimeFileListEntry[] = []
  for (const file of value.files) {
    if (
      typeof file !== 'object' ||
      file === null ||
      !('relativePath' in file) ||
      typeof file.relativePath !== 'string' ||
      !('basename' in file) ||
      typeof file.basename !== 'string' ||
      !('kind' in file) ||
      (file.kind !== 'text' && file.kind !== 'binary')
    ) {
      throw new Error('Invalid remote file inventory entry')
    }
    retainedBytes += 128 + (file.relativePath.length + file.basename.length) * 2
    if (
      retainedBytes > maxBytes ||
      !isUtf8ByteLengthWithinLimit(file.relativePath, FILE_INVENTORY_MAX_PATH_BYTES) ||
      !isUtf8ByteLengthWithinLimit(file.basename, FILE_INVENTORY_MAX_PATH_BYTES)
    ) {
      throw new FileInventoryCapacityError()
    }
    files.push({ relativePath: file.relativePath, basename: file.basename, kind: file.kind })
  }
  if (retainedBytes > maxBytes) {
    throw new FileInventoryCapacityError()
  }
  return {
    result: {
      worktree: value.worktree,
      rootPath: value.rootPath,
      files,
      totalCount: value.totalCount,
      truncated: value.truncated,
      ...('quickOpenSearchVersion' in value && typeof value.quickOpenSearchVersion === 'number'
        ? { quickOpenSearchVersion: value.quickOpenSearchVersion }
        : {})
    },
    retainedBytes
  }
}

export function pruneLegacyInventoryCache<T extends { retainedBytes: number }>(
  cache: Map<string, T>,
  maxEntries: number,
  maxBytes = FILE_INVENTORY_MAX_BYTES
): void {
  let bytes = Array.from(cache.values()).reduce((sum, entry) => sum + entry.retainedBytes, 0)
  while (cache.size > maxEntries || bytes > maxBytes) {
    const oldest = cache.entries().next().value
    if (!oldest) {
      break
    }
    bytes -= oldest[1].retainedBytes
    cache.delete(oldest[0])
  }
}
