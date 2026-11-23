import type { Root } from 'mdast'
import { forEachGitHubCallout } from '../../../../shared/github/markdown/github-callouts'

// Why: must run before remark-breaks, which splits the marker's newline into a break node.
export function remarkGitHubCallouts(): (tree: Root) => void {
  return (tree) =>
    forEachGitHubCallout(tree, (quote, kind) => {
      quote.data = { ...quote.data, hProperties: { ...quote.data?.hProperties, dataCallout: kind } }
    })
}
