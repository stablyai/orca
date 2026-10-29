import { vi } from 'vitest'
import { normalizeSourceControlAiSettings } from './source-control-ai-settings'

export function savedChatNamingCatalog(size: number) {
  const source = normalizeSourceControlAiSettings(undefined)
  source.selectedModelByAgent.claude = `catalog-${String(size - 1).padStart(4, '0')}`
  source.discoveredModelsByAgent = {
    claude: Array.from({ length: size }, (_, index) => ({
      id: `catalog-${String(index).padStart(4, '0')}`,
      label: `Catalog ${String(index).padStart(4, '0')}`
    }))
  }
  return source
}

export function observeChatNamingCatalogWork() {
  const clone = globalThis.structuredClone
  const work = { copiedRows: 0, copiedBytes: 0, selectedRowReads: 0 }
  let cloning = false
  const catalog = (value: unknown): unknown[] =>
    value !== null && typeof value === 'object' && 'claude' in value && Array.isArray(value.claude)
      ? value.claude
      : []
  vi.spyOn(globalThis, 'structuredClone').mockImplementation(
    <T>(value: T, options?: Parameters<typeof globalThis.structuredClone>[1]): T => {
      cloning = true
      let result: T
      try {
        const rows = catalog(value)
        work.copiedRows += rows.length
        if (rows.length) {
          work.copiedBytes += new TextEncoder().encode(JSON.stringify(rows)).length
        }
        result = clone(value, options)
      } finally {
        cloning = false
      }
      for (const row of catalog(result)) {
        if (
          row === null ||
          typeof row !== 'object' ||
          !('id' in row) ||
          typeof row.id !== 'string'
        ) {
          throw new Error('Expected a discovered model row')
        }
        const id = row.id
        Object.defineProperty(row, 'id', {
          enumerable: true,
          configurable: true,
          get: () => {
            if (!cloning) {
              work.selectedRowReads++
            }
            return id
          }
        })
      }
      return result
    }
  )
  return {
    work,
    reset: () => Object.assign(work, { copiedRows: 0, copiedBytes: 0, selectedRowReads: 0 })
  }
}
