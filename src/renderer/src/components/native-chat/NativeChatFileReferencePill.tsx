import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react'
import { basename } from '@/lib/path'
import { getFileTypeIcon } from '@/lib/file-type-icons'
import { NativeChatPromptPill } from './NativeChatPromptPill'

export function NativeChatFileReferencePill({ node, selected }: NodeViewProps): React.JSX.Element {
  const path = String(node.attrs.path)
  return (
    <NodeViewWrapper as="span" className="inline" contentEditable={false}>
      <NativeChatPromptPill
        icon={getFileTypeIcon(path)}
        label={basename(path)}
        selected={selected}
        title={path}
        data-native-chat-file-reference={path}
      />
    </NodeViewWrapper>
  )
}
