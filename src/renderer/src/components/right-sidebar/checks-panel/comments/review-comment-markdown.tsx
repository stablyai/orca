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
import type { Components } from 'react-markdown'
import type { CommentMarkdownExtension } from '@/components/sidebar/CommentMarkdown'
import { compactCommentMarkdownComponents } from '@/components/sidebar/comment-markdown-element-renderers'

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

const components: Components = {
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
