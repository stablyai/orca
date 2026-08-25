type HastNode = {
  type: string
  tagName?: string
  properties?: { className?: unknown }
  position?: unknown
  children?: HastNode[]
}

/**
 * Rehype plugin that wraps block math in a positioned `<div class="math-block">`.
 *
 * remark-math emits block math as `<pre><code class="math-display">`, and
 * rehype-katex then replaces the whole `<pre>` with a bare
 * `<span class="katex-display">` that carries no source position — so the
 * preview can't anchor a review note to it. Wrapping the `<pre>` first (this
 * plugin must run BEFORE rehype-katex) preserves the line range on the surviving
 * wrapper div, letting block math get the same annotation "+" as other blocks.
 */
export function rehypeWrapMathBlocks() {
  return (tree: HastNode): void => wrapMathBlocks(tree)
}

function wrapMathBlocks(node: HastNode): void {
  const children = node.children
  if (!children) {
    return
  }
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]
    if (child.tagName === 'pre' && containsMathCode(child)) {
      children[index] = {
        type: 'element',
        tagName: 'div',
        properties: { className: ['math-block'] },
        position: child.position,
        children: [child]
      }
      continue
    }
    // Don't descend into an existing wrapper, so a second pass can't double-wrap.
    if (child.tagName === 'div' && hasClass(child, 'math-block')) {
      continue
    }
    wrapMathBlocks(child)
  }
}

// Match on `language-math` as well as `math-display`. This plugin runs after
// rehype-sanitize, and `language-math` survives it reliably, whereas the
// `math-display` allowance depends on sanitize-schema merge quirks — matching
// either keeps detection robust regardless.
function containsMathCode(pre: HastNode): boolean {
  return (pre.children ?? []).some(
    (child) =>
      child.tagName === 'code' &&
      (hasClass(child, 'math-display') || hasClass(child, 'language-math'))
  )
}

function hasClass(node: HastNode, className: string): boolean {
  const value = node.properties?.className
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\s+/) : []
  return list.includes(className)
}
