import type { Root, RootContent } from 'hast'

type Node = Root | RootContent

/** Substitute authenticated previews while consuming GitLab image-size annotations. */
export function rehypeGitLabImages(sources: Readonly<Record<string, string>>) {
  return () =>
    (tree: Root): void => {
      const visit = (node: Node): void => {
        if (!('children' in node)) {
          return
        }
        node.children.forEach((child, index) => {
          if (child.type === 'element' && child.tagName === 'img') {
            const src = child.properties.src
            if (typeof src === 'string' && Object.hasOwn(sources, src)) {
              child.properties.src = sources[src]
            }
            const next = node.children[index + 1]
            const size =
              next?.type === 'text' &&
              /^\{((?:(?:width|height)=\d+(?:px|%)?\s*)+)\}/.exec(next.value)
            if (size && next.type === 'text') {
              for (const match of size[1].matchAll(/(width|height)=(\d+)(px|%)?/g)) {
                const value = Number(match[2])
                if (value > 0 && value <= (match[3] === '%' ? 100 : 8192)) {
                  child.properties[match[1]] = match[3] === '%' ? `${value}%` : value
                }
              }
              next.value = next.value.slice(size[0].length)
            }
          }
          visit(child)
        })
      }
      visit(tree)
    }
}
