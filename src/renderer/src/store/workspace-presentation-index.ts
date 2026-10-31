import type { WorkspacePresentationKey } from '../../../shared/workspace-presentation'

type Node = { value?: WorkspacePresentationKey; children: ReadonlyMap<string, Node> }
const EMPTY: Node = { children: new Map() }

/** Persistent radix path: one binding edit copies its key's path, never all workspace bindings. */
export class WorkspacePresentationIndex {
  constructor(private readonly root: Node = EMPTY) {}

  get(key: string): WorkspacePresentationKey | undefined {
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

  delete(key: string): WorkspacePresentationIndex {
    return this.update(key, undefined)
  }

  set(key: string, value: WorkspacePresentationKey): WorkspacePresentationIndex {
    return this.update(key, value)
  }

  private update(
    key: string,
    value: WorkspacePresentationKey | undefined
  ): WorkspacePresentationIndex {
    const chars = [...key]
    const put = (node: Node, at: number): Node => {
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
    return root === this.root ? this : new WorkspacePresentationIndex(root)
  }
}
