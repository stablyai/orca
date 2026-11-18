import remarkBreaks from 'remark-breaks'
import { remarkGitHubCallouts } from '@/lib/markdown/remark-github-callouts'
import { commentMarkdownParsePlugins } from '../../../../shared/comment-markdown-parse-plugins'

// Keep image-source discovery on the same grammar as the rendered prose.
export const commentMarkdownRemarkPlugins = [
  ...commentMarkdownParsePlugins,
  remarkGitHubCallouts,
  remarkBreaks
]
