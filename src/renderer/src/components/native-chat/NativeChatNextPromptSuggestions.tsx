import { useContext } from 'react'
import { NativeChatNextPromptsContext } from './native-chat-next-prompts-context'
import { Button } from '@/components/ui/button'
import type { NativeChatComposerFieldProps } from './NativeChatComposerField'
import { writeNativeChatComposerText } from './native-chat-composer-input'

type NextPromptProps = Pick<
  NativeChatComposerFieldProps,
  | 'nextPromptsBlocked'
  | 'textareaRef'
  | 'draft'
  | 'disabled'
  | 'canSend'
  | 'unavailableHint'
  | 'isWorking'
  | 'isStopping'
  | 'imageAttachments'
  | 'imeEnterGesture'
  | 'onDraftChange'
>

export function NativeChatNextPromptSuggestions(props: NextPromptProps): React.JSX.Element | null {
  const { textareaRef, onDraftChange } = props
  const nextPrompts = useContext(NativeChatNextPromptsContext)
  const blocked = Boolean(
    props.draft ||
    props.imageAttachments.length ||
    props.disabled ||
    !props.canSend ||
    props.unavailableHint !== undefined ||
    props.isWorking ||
    props.isStopping ||
    props.nextPromptsBlocked
  )
  if (!nextPrompts?.length || blocked) {
    return null
  }
  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {nextPrompts.map((prompt) => (
        <Button
          key={prompt}
          type="button"
          variant="outline"
          size="sm"
          className="h-auto max-w-full whitespace-normal text-left"
          onClick={() => {
            const input = textareaRef.current
            // 点击时复查实时编辑器，避免覆盖尚未同步到 React 的输入。
            if (!input || input.value || input.disabled || props.imeEnterGesture.isComposing()) {
              return
            }
            writeNativeChatComposerText(input, prompt, prompt.length)
            onDraftChange(prompt, input)
          }}
        >
          {prompt}
        </Button>
      ))}
    </div>
  )
}
