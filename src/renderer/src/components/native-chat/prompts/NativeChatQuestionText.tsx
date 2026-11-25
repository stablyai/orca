import type { ComponentProps } from 'react'
import { NativeChatCodeBlock } from '../markdown/code/NativeChatCodeBlock'
import { NativeChatMarkdown } from '../markdown/NativeChatMarkdown'

type QuestionTextProps = Pick<ComponentProps<typeof NativeChatMarkdown>, 'content' | 'className'>

export function NativeChatQuestionText({ ...props }: QuestionTextProps): React.JSX.Element {
  return (
    <NativeChatMarkdown
      {...props}
      variant="document"
      renderCodeBlock={NativeChatCodeBlock}
      linkifyFilePaths
    />
  )
}
