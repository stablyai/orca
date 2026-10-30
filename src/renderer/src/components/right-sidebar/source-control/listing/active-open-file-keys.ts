import type { DiffSource } from '@/store/slices/editor'

const EMPTY_OPEN_ROW_KEYS: ReadonlySet<string> = new Set()

const SIGNATURE_SEPARATOR = '::'

/** Use a primitive diffSource::relativePath signature so selectors stay stable across unrelated store updates. */
export function buildActiveOpenFileSignature(
  diffSource: DiffSource | undefined,
  relativePath: string
): string {
  return `${diffSource ?? 'edit'}${SIGNATURE_SEPARATOR}${relativePath}`
}

/** Match diffs to their staging side; plain editors prefer working-tree rows with staged-only fallback. */
export function buildActiveOpenRowKeys(
  signature: string | null,
  availableRowKeys?: ReadonlySet<string>
): ReadonlySet<string> {
  if (!signature) {
    return EMPTY_OPEN_ROW_KEYS
  }

  const separatorIndex = signature.indexOf(SIGNATURE_SEPARATOR)
  if (separatorIndex === -1) {
    return EMPTY_OPEN_ROW_KEYS
  }

  const diffSource = signature.slice(0, separatorIndex)
  const path = signature.slice(separatorIndex + SIGNATURE_SEPARATOR.length)
  if (path.length === 0) {
    return EMPTY_OPEN_ROW_KEYS
  }

  if (diffSource === 'staged') {
    return filterAvailableRowKeys([`staged::${path}`], availableRowKeys)
  }

  const workingTreeKeys = [`unstaged::${path}`, `untracked::${path}`]
  if (diffSource === 'unstaged') {
    return filterAvailableRowKeys(workingTreeKeys, availableRowKeys)
  }

  if (diffSource === 'edit') {
    const availableWorkingTreeKeys = filterAvailableRowKeys(workingTreeKeys, availableRowKeys)
    if (availableWorkingTreeKeys.size > 0 || !availableRowKeys) {
      return availableWorkingTreeKeys
    }
    return filterAvailableRowKeys([`staged::${path}`], availableRowKeys)
  }

  return EMPTY_OPEN_ROW_KEYS
}

function filterAvailableRowKeys(
  candidates: string[],
  availableRowKeys: ReadonlySet<string> | undefined
): ReadonlySet<string> {
  if (!availableRowKeys) {
    return new Set(candidates)
  }
  const keys = candidates.filter((key) => availableRowKeys.has(key))
  return keys.length > 0 ? new Set(keys) : EMPTY_OPEN_ROW_KEYS
}
