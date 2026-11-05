import {
  BookOpen,
  Bot,
  BrushCleaning,
  CircleAlert,
  CircleMinus,
  CircleX,
  ClockAlert,
  Cog,
  FileCheck,
  FileMinusCorner,
  FilePlusCorner,
  Files,
  FileWarning,
  FileX,
  Folders,
  GitCommitHorizontal,
  Info,
  LayersPlus,
  Link,
  MessageSquareMore,
  MessageSquareOff,
  MessageSquareX,
  Network,
  Plug,
  Route,
  SearchCode,
  ShieldAlert,
  ShieldCheck,
  ShieldPlus,
  ShieldQuestion,
  TriangleAlert,
  UserRound,
  Wrench,
  type LucideIcon
} from 'lucide-react'
import React from 'react'
import type { Components } from 'react-markdown'
import type { CommentMarkdownExtension } from '@/components/sidebar/CommentMarkdown'
import { compactCommentMarkdownComponents } from '@/components/sidebar/comment-markdown-element-renderers'
import { isMermaidPre, renderMermaidFence } from '@/components/sidebar/comment-mermaid-fence'

const icons = new Map<string, LucideIcon>([
  ['book-open', BookOpen],
  ['bot', Bot],
  ['brush-cleaning', BrushCleaning],
  ['ci-failure', CircleX],
  ['clock-alert', ClockAlert],
  ['cog', Cog],
  ['common-learnings', BookOpen],
  ['file-minus-corner', FileMinusCorner],
  ['file-no-changes', FileCheck],
  ['file-plus-corner', FilePlusCorner],
  ['file-similar', Files],
  ['file-too-large', FileWarning],
  ['file-unavailable', FileX],
  ['folders', Folders],
  ['git-commit-horizontal', GitCommitHorizontal],
  ['individual-learning', UserRound],
  ['info', Info],
  ['layers-plus', LayersPlus],
  ['learnings', BookOpen],
  ['linked-repositories', Link],
  ['message-square-more', MessageSquareMore],
  ['message-square-off', MessageSquareOff],
  ['message-square-x', MessageSquareX],
  ['network', Network],
  ['plug', Plug],
  ['review-details', SearchCode],
  ['route', Route],
  ['shield-plus', ShieldPlus],
  ['wrench', Wrench]
])

const severityIcons = new Map<string, LucideIcon>([
  ['amber', CircleAlert],
  ['critical', TriangleAlert],
  ['high', TriangleAlert],
  ['informational', Info],
  ['major', TriangleAlert],
  ['neutral', CircleMinus],
  ['priority-low', CircleMinus],
  ['priority-normal', CircleAlert],
  ['priority-urgent', TriangleAlert],
  ['risk-high', ShieldAlert],
  ['risk-low', ShieldCheck],
  ['risk-normal', ShieldAlert],
  ['risk-unassessed', ShieldQuestion],
  ['risk-urgent', ShieldAlert]
])

const CompactImage = compactCommentMarkdownComponents.img
const CompactPre = compactCommentMarkdownComponents.pre

// Bound the diagram so a tall one cannot take over the sidebar; click expands it.
const diagramClassName =
  'my-1 max-w-full overflow-hidden rounded border border-border/50 p-1.5 [&_.mermaid-block_svg]:max-h-60 [&_.mermaid-block_pre]:my-0 [&_.mermaid-block_pre]:max-h-32 [&_.mermaid-block_pre]:overflow-auto [&_.mermaid-block_pre]:rounded [&_.mermaid-block_pre]:bg-accent [&_.mermaid-block_pre]:p-1.5 [&_.mermaid-block_pre]:font-mono [&_.mermaid-block_pre]:text-[10px]'

const components: Components = {
  // Review bots (Greptile) post Mermaid diagrams; show them as diagrams, with the source until they render.
  pre: ({ children }) => {
    const source = CompactPre ? <CompactPre>{children}</CompactPre> : <pre>{children}</pre>
    const code = React.Children.toArray(children)[0]
    return isMermaidPre(children) && React.isValidElement<{ children?: React.ReactNode }>(code)
      ? renderMermaidFence(code.props.children, diagramClassName, source)
      : source
  },
  picture: ({ children }) => <>{children}</>,
  source: () => null,
  img: ({ src, alt }) => {
    // Substitute local icons; review comments must not gain a remote-image fetch path.
    const name = src
      ?.match(
        /^https:\/\/storage\.googleapis\.com\/coderabbit_public_assets\/review-comment-icons-v1\/([a-z0-9-]+)\.svg$/
      )?.[1]
      ?.replace(/-dark$/, '')
    const severity = name?.match(/^(.+)-(?:16|20)$/)?.[1]
    const Icon = name
      ? (icons.get(name) ?? (severity ? severityIcons.get(severity) : undefined))
      : undefined
    if (!Icon) {
      return CompactImage ? <CompactImage src={src} alt={alt} /> : null
    }

    const color =
      severity === 'critical' || severity?.endsWith('urgent')
        ? 'text-destructive'
        : severity === 'amber' ||
            severity === 'major' ||
            severity === 'high' ||
            severity === 'risk-high'
          ? 'text-status-warning-text'
          : 'text-muted-foreground'

    return (
      <span
        className={`inline-flex align-middle ${color}`}
        role={alt ? 'img' : undefined}
        aria-label={alt || undefined}
        aria-hidden={alt ? undefined : true}
      >
        <Icon className="size-4" aria-hidden="true" />
      </span>
    )
  }
}

export const reviewCommentMarkdown: CommentMarkdownExtension = {
  remarkPlugins: [],
  sanitizeAttributes: {},
  components
}
