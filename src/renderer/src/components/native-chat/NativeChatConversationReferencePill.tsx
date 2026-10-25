import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react'
import { NativeChatConversationReference } from './NativeChatConversationReference'

export function NativeChatConversationReferencePill({
  node,
  selected
}: NodeViewProps): React.JSX.Element {
  return (
    <NodeViewWrapper as="span" className="inline" contentEditable={false}>
      <NativeChatConversationReference
        uri={String(node.attrs.uri)}
        title={String(node.attrs.title)}
        selected={selected}
      />
    </NodeViewWrapper>
  )
}
