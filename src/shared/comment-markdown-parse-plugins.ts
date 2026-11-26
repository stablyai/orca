import remarkGfm from 'remark-gfm'
import remarkCjkFriendly from 'remark-cjk-friendly/parseOnly'
import type { PluggableList } from 'unified'
import { remarkAutolinkLiteralProseBoundary } from './remark-autolink-literal-prose-boundary'

export const commentMarkdownParsePlugins = [
  remarkGfm,
  remarkCjkFriendly,
  remarkAutolinkLiteralProseBoundary
] satisfies PluggableList
