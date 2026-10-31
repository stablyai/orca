import type { WorkspacePresentationKey } from '../../../shared/workspace-presentation'

type Node<T> = { value?: T; children: ReadonlyMap<string, Node<T>> }
const EMPTY: Node<never> = { children: new Map() }

/** Persistent radix path: one binding edit copies its key's path, never all workspace bindings. */
export class WorkspacePresentationIndex<T = WorkspacePresentationKey> {
  constructor(private readonly root: Node<T> = EMPTY) {}

  get(key: string): T | undefined {
    let node = this.root
    for (const char of key) {
      const child = node.children.get(char)
      if (!child) {
        return undefined
      }
      node = child
    }
    return node.value
  }

  delete(key: string): WorkspacePresentationIndex<T> {
    return this.update(key, undefined)
  }

  set(key: string, value: T): WorkspacePresentationIndex<T> {
    return this.update(key, value)
  }

  private update(key: string, value: T | undefined): WorkspacePresentationIndex<T> {
    const chars = [...key]
    const put = (node: Node<T>, at: number): Node<T> => {
      if (at === chars.length) {
        return node.value === value ? node : { ...node, value }
      }
      const char = chars[at]
      const old = node.children.get(char) ?? EMPTY
      const child = put(old, at + 1)
      if (old === child) {
        return node
      }
      const children = new Map(node.children)
      if (child.value === undefined && child.children.size === 0) {
        children.delete(char)
      } else {
        children.set(char, child)
      }
      return { ...node, children }
    }
    const root = put(this.root, 0)
    return root === this.root ? this : new WorkspacePresentationIndex<T>(root)
  }
}
