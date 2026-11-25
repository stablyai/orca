import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import type { Pluggable } from 'unified'
import { remarkGitHubCallouts } from '@/lib/markdown/remark-github-callouts'
import { commentMarkdownParsePlugins } from '../../../../shared/comment-markdown-parse-plugins'

// Keep image-source discovery on the same grammar as the rendered prose.
export const commentMarkdownRemarkPlugins = [
  ...commentMarkdownParsePlugins,
  remarkGitHubCallouts,
  remarkBreaks
]

// Agents write ranges like 1~2, so agent text strikes only ~~double~~ tildes, as mobile does.
// unified merges these options into the shared remark-gfm entry instead of adding a second one.
export const doubleTildeStrikethrough: Pluggable = [remarkGfm, { singleTilde: false }]
