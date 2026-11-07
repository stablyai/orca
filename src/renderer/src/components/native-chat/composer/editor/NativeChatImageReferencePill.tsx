import { createContext, useContext } from 'react'
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react'
import { ImageIcon, ImageOff } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { NativeChatPromptPill } from './NativeChatPromptPill'

/** The ids of the composer's thumbnail row, in order: what numbers a chip and its thumbnail. */
const ImageRowContext = createContext<readonly string[]>([])

export const NativeChatImageRowProvider = ImageRowContext.Provider

export function nativeChatImageNumberLabel(number: number): string {
  return translate('components.native-chat.composer.imageNumber', 'Image #{{number}}', { number })
}

export function NativeChatImageReferencePill({ node, selected }: NodeViewProps): React.JSX.Element {
  const attachmentId = String(node.attrs.attachmentId)
  const index = useContext(ImageRowContext).indexOf(attachmentId)
  return (
    <NodeViewWrapper as="span" className="inline" contentEditable={false}>
      <NativeChatPromptPill
        icon={index === -1 ? ImageOff : ImageIcon}
        label={
          index === -1
            ? translate('components.native-chat.composer.imageReferenceMissing', 'Image removed')
            : nativeChatImageNumberLabel(index + 1)
        }
        selected={selected}
        data-native-chat-image-reference={attachmentId}
      />
    </NodeViewWrapper>
  )
}
