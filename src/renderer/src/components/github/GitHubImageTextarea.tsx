import { useCallback, useRef, type ComponentProps, type Ref } from 'react'
import { ImeTextarea } from '@/lib/text-input/ime/ime-text-field'
import { useGitHubTextareaImages } from './use-github-textarea-images'
import type { GitHubImageIntake } from './use-github-image-uploads'

type Props = Omit<ComponentProps<typeof ImeTextarea>, 'value' | 'onChange' | 'ref'> & {
  value: string
  onValueChange: (value: string) => void
  imageUpload?: GitHubImageIntake
  ref?: Ref<HTMLTextAreaElement>
}

export function GitHubImageTextarea({ value, onValueChange, imageUpload, ref, ...props }: Props) {
  const hasImageUpload = !!imageUpload
  const node = useRef<HTMLTextAreaElement | null>(null)
  const images = useGitHubTextareaImages(node, value, onValueChange, {
    ...imageUpload,
    enabled: !!imageUpload && !props.disabled
  })
  const { attachDrop } = images
  const attach = useCallback(
    (element: HTMLTextAreaElement | null) => {
      if (hasImageUpload) {
        attachDrop(element)
      } else {
        node.current = element
      }
      if (typeof ref === 'function') {
        ref(element)
      } else if (ref) {
        ref.current = element
      }
    },
    [attachDrop, hasImageUpload, ref]
  )
  return (
    <ImeTextarea
      {...props}
      ref={attach}
      value={images.value}
      onChange={(event) => images.change(event.target.value)}
      onBeforeInput={images.onBeforeInput}
      onPaste={images.onPaste}
    />
  )
}
