import { isAlias, isMap, isPair, isScalar, isSeq, visit } from 'yaml'
import type { Alias, Document, Node } from 'yaml'
import { MAX_ORCA_YAML_CODE_UNITS } from './orca-yaml-file-limit'

type ConversionSize = { entries: number; mappingEntries: number }

/** Merge aliases re-convert maps; yaml's alias counter does not bound that work. */
export function isOrcaYamlConversionWithinLimit(document: Document): boolean {
  const anchors = new Map<string, Node>()
  const targets = new Map<Alias, Node | undefined>()
  visit(document, {
    Node(_key, node) {
      if (isAlias(node)) {
        targets.set(node, anchors.get(node.source))
      } else if (node.anchor) {
        anchors.set(node.anchor, node)
      }
    }
  })

  const measured = new Map<object, ConversionSize>()
  const active = new Set<object>()
  const zero = { entries: 0, mappingEntries: 0 }
  /** Use the source-text cap as a separate collection-work budget. */
  const bound = (value: number): number => {
    if (value > MAX_ORCA_YAML_CODE_UNITS) {
      throw new Error('YAML conversion budget exceeded')
    }
    return value
  }
  /** Cache repeat-conversion cost, rather than counting a node only once. */
  function measure(node: unknown): ConversionSize {
    if (!isMap(node) && !isSeq(node) && !isPair(node)) {
      return zero
    }
    const cached = measured.get(node)
    if (cached) {
      return cached
    }
    if (active.has(node)) {
      throw new Error('Cyclic YAML merge')
    }
    active.add(node)
    let entries = 0
    let mappingEntries = 0
    if (isSeq(node)) {
      entries = node.items.length
      for (const item of node.items) {
        entries = bound(entries + measure(item).entries)
      }
    } else {
      const pairs = isPair(node) ? [node] : node.items
      for (const pair of pairs) {
        const mergeKey =
          isScalar(pair.key) &&
          (typeof pair.key.value === 'symbol'
            ? pair.key.value.description === '<<'
            : pair.key.value === '<<' && (!pair.key.type || pair.key.type === 'PLAIN'))
        if (!mergeKey) {
          mappingEntries = bound(mappingEntries + 1)
          entries = bound(entries + 1 + measure(pair.key).entries + measure(pair.value).entries)
          continue
        }
        const value = isAlias(pair.value) ? targets.get(pair.value) : pair.value
        const sources = isSeq(value) ? value.items : [value]
        for (const source of sources) {
          const resolved = isAlias(source) ? targets.get(source) : source
          if (!isMap(resolved)) {
            throw new Error('YAML merge source must be a map')
          }
          const size = measure(resolved)
          // Count source conversion and merge iteration, even for overridden keys.
          entries = bound(entries + size.entries + size.mappingEntries)
          mappingEntries = bound(mappingEntries + size.mappingEntries)
        }
      }
    }
    active.delete(node)
    const size = { entries, mappingEntries }
    measured.set(node, size)
    return size
  }
  try {
    measure(document.contents)
    return true
  } catch {
    return false
  }
}
