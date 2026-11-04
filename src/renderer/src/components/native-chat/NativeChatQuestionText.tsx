import type { ComponentProps } from 'react'
import { NativeChatCodeBlock } from './NativeChatCodeBlock'
import { NativeChatMarkdown } from './NativeChatMarkdown'

type QuestionTextProps = Pick<
  ComponentProps<typeof NativeChatMarkdown>,
  'content' | 'onLinkClick' | 'className'
>

export function NativeChatQuestionText({
  onLinkClick,
  ...props
}: QuestionTextProps): React.JSX.Element {
  return (
    <NativeChatMarkdown
      {...props}
      variant="document"
      renderCodeBlock={NativeChatCodeBlock}
      onLinkClick={onLinkClick}
      allowFileUriLinks={onLinkClick !== undefined}
      linkifyFilePaths={onLinkClick !== undefined}
    />
  )
}
