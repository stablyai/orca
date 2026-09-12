export const TOOL_PATH_KEYS = ['file_path', 'filePath', 'path', 'notebook_path', 'changes'] as const
export const TOOL_PRIMARY_KEYS = [
  'query',
  'pattern',
  'directory',
  'command',
  'cmd',
  'url',
  'description'
] as const

export function ownToolInputValue(value: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor && 'value' in descriptor ? descriptor.value : undefined
}

export function defineToolInputValue(value: object, key: PropertyKey, item: unknown): void {
  Object.defineProperty(value, key, {
    value: item,
    enumerable: true,
    configurable: true,
    writable: true
  })
}

export type ToolPathSelection = { key: string; value: unknown } | null | 'unknown'

export function selectToolInputPath(
  read: (key: string) => unknown,
  search: () => boolean | 'unknown',
  patch: () => unknown
): ToolPathSelection {
  for (const key of ['file_path', 'filePath']) {
    const value = read(key)
    if (value != null) {
      return { key, value }
    }
  }
  const path = read('path')
  if (path != null) {
    const classification = search()
    if (classification === 'unknown') {
      return 'unknown'
    }
    if (!classification) {
      return { key: 'path', value: path }
    }
  }
  const notebook = read('notebook_path')
  if (notebook != null) {
    return { key: 'notebook_path', value: notebook }
  }
  const change = patch()
  return change === undefined ? null : { key: 'changes', value: change }
}

export function ownToolArgParts(input: unknown): string[] | null {
  if (!Array.isArray(input) || input.length === 0) {
    return null
  }
  const parts: string[] = []
  for (let index = 0; index < input.length; index++) {
    const part = ownToolInputValue(input, index)
    if (typeof part !== 'string') {
      return null
    }
    parts.push(part)
  }
  return parts
}
