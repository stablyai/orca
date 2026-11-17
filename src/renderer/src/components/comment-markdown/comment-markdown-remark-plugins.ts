import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import remarkCjkFriendly from 'remark-cjk-friendly/parseOnly'
import { remarkGitHubCallouts } from '@/lib/markdown/remark-github-callouts'
import { remarkAutolinkLiteralProseBoundary } from '@/lib/markdown/remark-autolink-literal-prose-boundary'

// Keep image-source discovery on the same grammar as the rendered prose.
export const commentMarkdownRemarkPlugins = [
  remarkGfm,
  remarkCjkFriendly,
  remarkAutolinkLiteralProseBoundary,
  remarkGitHubCallouts,
  remarkBreaks
]
