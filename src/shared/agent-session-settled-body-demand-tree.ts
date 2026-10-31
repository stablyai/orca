type Node<T> = {
  value: T
  order: number
  bytes: number
  minimum: number
  height: number
  left: Node<T> | null
  right: Node<T> | null
}
export type SettledBodyDemandOperations = {
  indexSteps: number
  candidateExaminations: number
  headUpdates: number
  ownerGroups: number
  queueOperations: number
}
const height = <T>(node: Node<T> | null): number => node?.height ?? 0

export class SettledBodyDemandTree<T> {
  private root: Node<T> | null = null
  size = 0
  constructor(private readonly operations: SettledBodyDemandOperations) {}

  private refresh(node: Node<T>): Node<T> {
    this.operations.indexSteps++
    node.height = 1 + Math.max(height(node.left), height(node.right))
    node.minimum = Math.min(
      node.bytes,
      node.left?.minimum ?? Infinity,
      node.right?.minimum ?? Infinity
    )
    return node
  }
  private rotate(node: Node<T>, direction: 'left' | 'right'): Node<T> {
    const opposite = direction === 'left' ? 'right' : 'left'
    const pivot = node[opposite]
    if (!pivot) {
      return node
    }
    node[opposite] = pivot[direction]
    pivot[direction] = this.refresh(node)
    return this.refresh(pivot)
  }
  private balance(node: Node<T>): Node<T> {
    this.refresh(node)
    if (height(node.left) > height(node.right) + 1 && node.left) {
      if (height(node.left.right) > height(node.left.left)) {
        node.left = this.rotate(node.left, 'left')
      }
      return this.rotate(node, 'right')
    }
    if (height(node.right) > height(node.left) + 1 && node.right) {
      if (height(node.right.left) > height(node.right.right)) {
        node.right = this.rotate(node.right, 'right')
      }
      return this.rotate(node, 'left')
    }
    return node
  }
  add(value: T, order: number, bytes: number): void {
    const insert = (node: Node<T> | null): Node<T> => {
      this.operations.indexSteps++
      if (!node) {
        return { value, order, bytes, minimum: bytes, height: 1, left: null, right: null }
      }
      if (order < node.order) {
        node.left = insert(node.left)
      } else {
        node.right = insert(node.right)
      }
      return this.balance(node)
    }
    this.root = insert(this.root)
    this.size++
  }
  delete(order: number): void {
    const remove = (node: Node<T> | null, key: number): Node<T> | null => {
      this.operations.indexSteps++
      if (!node) {
        return null
      }
      if (key < node.order) {
        node.left = remove(node.left, key)
      } else if (key > node.order) {
        node.right = remove(node.right, key)
      } else {
        if (!node.left || !node.right) {
          return node.left ?? node.right
        }
        let successor = node.right
        while (successor.left) {
          this.operations.indexSteps++
          successor = successor.left
        }
        node.value = successor.value
        node.order = successor.order
        node.bytes = successor.bytes
        node.right = remove(node.right, successor.order)
      }
      return this.balance(node)
    }
    this.root = remove(this.root, order)
    this.size--
  }
  firstFitting(bytes: number): T | null {
    this.operations.indexSteps++
    let node = this.root
    if (!node || node.minimum > bytes) {
      return null
    }
    while (node) {
      this.operations.indexSteps++
      if (node.left && node.left.minimum <= bytes) {
        node = node.left
      } else {
        this.operations.candidateExaminations++
        if (node.bytes <= bytes) {
          return node.value
        }
        node = node.right
      }
    }
    return null
  }
}
