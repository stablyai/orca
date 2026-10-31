import { isWorkspacePresentationKey } from './workspace-presentation'
import type {
  WorkspacePresentation,
  WorkspacePresentationDocuments,
  WorkspacePresentationKey
} from './workspace-presentation'

type Node = { value?: WorkspacePresentation; children: ReadonlyMap<string, Node> }
const empty: Node = { children: new Map() }
const sizes = new WeakMap<WorkspacePresentationDocuments, number>()
export function hasWorkspacePresentationDocuments(
  documents: WorkspacePresentationDocuments | undefined
): boolean {
  if (!documents) {
    return false
  }
  let size = sizes.get(documents)
  if (size === undefined) {
    size = Object.keys(documents).length
    sizes.set(documents, size)
  }
  return size > 0
}
const roots = new WeakMap<WorkspacePresentationDocuments, Node>()
function update(
  node: Node,
  chars: readonly string[],
  at: number,
  value: WorkspacePresentation | undefined
): Node {
  if (at === chars.length) {
    return node.value === value ? node : { ...node, value }
  }
  const char = chars[at],
    previous = node.children.get(char) ?? empty
  const child = update(previous, chars, at + 1, value)
  if (previous === child) {
    return node
  }
  const children = new Map(node.children)
  if (child.value === undefined && !child.children.size) {
    children.delete(char)
  } else {
    children.set(char, child)
  }
  return { ...node, children }
}
function rootFor(documents: WorkspacePresentationDocuments): Node {
  let root = roots.get(documents)
  if (!root) {
    root = empty
    for (const [key, value] of Object.entries(documents)) {
      if (value) {
        root = update(root, [...key], 0, value)
      }
    }
    roots.set(documents, root)
  }
  return root
}

/** Shared radix branches make an acknowledged-save delta proportional to changed keys. */
export function workspacePresentationDocumentDelta(
  previous: WorkspacePresentationDocuments,
  current: WorkspacePresentationDocuments
): { changed: WorkspacePresentationDocuments; removed: WorkspacePresentationKey[] } {
  const changed: WorkspacePresentationDocuments = {}
  const removed: WorkspacePresentationKey[] = []
  const visit = (before: Node, after: Node, prefix: string): void => {
    if (before === after) {
      return
    }
    if (before.value !== after.value && isWorkspacePresentationKey(prefix)) {
      const key = prefix
      if (after.value) {
        changed[key] = after.value
      } else {
        removed.push(key)
      }
    }
    for (const char of new Set([...before.children.keys(), ...after.children.keys()])) {
      visit(before.children.get(char) ?? empty, after.children.get(char) ?? empty, prefix + char)
    }
  }
  visit(rootFor(previous), rootFor(current), '')
  return { changed, removed }
}

/** Immutable per-document edits do not copy unrelated saved presentations. */
export function editWorkspacePresentationDocuments(
  documents: WorkspacePresentationDocuments,
  key: WorkspacePresentationKey,
  value: WorkspacePresentation | undefined
): WorkspacePresentationDocuments {
  const root = rootFor(documents)
  hasWorkspacePresentationDocuments(documents)
  const size = sizes.get(documents) ?? 0
  const nextSize = size + (value ? 1 : 0) - (documents[key] ? 1 : 0)
  const next = update(root, [...key], 0, value)
  if (next === root) {
    return documents
  }
  const read = (key: string): WorkspacePresentation | undefined => {
    let node = next
    for (const char of key) {
      const child = node.children.get(char)
      if (!child) {
        return undefined
      }
      node = child
    }
    return node.value
  }
  const keys = (): string[] => {
    const result: string[] = []
    const visit = (node: Node, prefix: string): void => {
      if (node.value) {
        result.push(prefix)
      }
      for (const [char, child] of node.children) {
        visit(child, prefix + char)
      }
    }
    visit(next, '')
    return result
  }
  const record: WorkspacePresentationDocuments = new Proxy(
    {},
    {
      get: (_target, key) => (typeof key === 'string' ? read(key) : undefined),
      has: (_target, key) => typeof key === 'string' && read(key) !== undefined,
      ownKeys: keys,
      getOwnPropertyDescriptor: (_target, key) =>
        typeof key === 'string' && read(key)
          ? { configurable: true, enumerable: true, value: read(key) }
          : undefined
    }
  )
  roots.set(record, next)
  sizes.set(record, nextSize)
  return record
}
