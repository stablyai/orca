import { Fragment, jsx, jsxs } from 'react/jsx-runtime'
import { toJsxRuntime } from 'hast-util-to-jsx-runtime'
import type { Root, RootContent } from 'hast'
import type { Components } from 'react-markdown'
import { markdownPreviewUrlTransform } from './markdown-preview-url-transform'

function transformUrls(node: Root | RootContent): void {
  if (node.type === 'element') {
    for (const key of ['href', 'src']) {
      const value = node.properties[key]
      if (typeof value === 'string') {
        node.properties[key] = markdownPreviewUrlTransform(value, key)
      }
    }
  }
  if ('children' in node) {
    for (const child of node.children) {
      transformUrls(child)
    }
  }
}

export function renderMarkdownPreviewTree(tree: Root, components: Components): React.ReactNode {
  const copy = structuredClone(tree)
  transformUrls(copy)
  return toJsxRuntime(copy, {
    Fragment,
    jsx,
    jsxs,
    components,
    passNode: true,
    passKeys: true,
    ignoreInvalidStyle: true
  })
}
