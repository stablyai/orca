import { createContext, useContext, useMemo } from 'react'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { jiraImageReference } from '../../../shared/jira-attachment-image'
import CommentMarkdown from './sidebar/CommentMarkdown'
import { selectCommentMarkdownComponents } from './sidebar/comment-markdown-element-renderers'
import { JiraAttachmentImage } from './jira-attachment-image'

const JiraMarkdownContext = createContext<{ target: RuntimeClientTarget; compact: boolean }>({
  target: { kind: 'local' },
  compact: false
})

function JiraMarkdownImage(props: React.ComponentProps<'img'>): React.JSX.Element | null {
  const { target, compact } = useContext(JiraMarkdownContext)
  const reference = jiraImageReference(props.src)
  if (reference) {
    return (
      <JiraAttachmentImage
        target={target}
        reference={reference}
        alt={props.alt}
        compact={compact}
      />
    )
  }
  const BaseImage = selectCommentMarkdownComponents({
    variant: compact ? 'compact' : 'document',
    expandImages: true
  }).img
  return BaseImage ? <BaseImage src={props.src} alt={props.alt} /> : null
}

const imageExtension = {
  remarkPlugins: [],
  sanitizeAttributes: {},
  components: { img: JiraMarkdownImage }
}

export function JiraIssueMarkdown({
  target,
  content,
  compact = false,
  className
}: {
  target: RuntimeClientTarget
  content: string
  compact?: boolean
  className?: string
}): React.JSX.Element {
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  const value = useMemo<{ target: RuntimeClientTarget; compact: boolean }>(
    () => ({
      target: environmentId ? { kind: 'environment', environmentId } : { kind: 'local' },
      compact
    }),
    [environmentId, compact]
  )
  return (
    <JiraMarkdownContext.Provider value={value}>
      <CommentMarkdown
        content={content}
        variant={compact ? 'compact' : 'document'}
        expandImages
        extension={imageExtension}
        className={className}
      />
    </JiraMarkdownContext.Provider>
  )
}
