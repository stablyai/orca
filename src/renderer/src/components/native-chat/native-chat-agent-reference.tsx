import {
  Node,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type Editor,
  type NodeViewProps
} from '@tiptap/react'
import { Users } from 'lucide-react'
import { NativeChatPromptPill } from './NativeChatPromptPill'
import {
  agentReferenceToken,
  type OrchestrationAgentReference
} from '../../../../shared/orchestration-agent-reference'
import { closeHistory } from '@tiptap/pm/history'

function AgentReferencePill({ node, selected }: NodeViewProps): React.JSX.Element {
  return (
    <NodeViewWrapper
      as="span"
      className="inline"
      contentEditable={false}
      data-native-chat-agent-reference={node.attrs.address}
    >
      <NativeChatPromptPill icon={Users} label={String(node.attrs.label)} selected={selected} />
    </NodeViewWrapper>
  )
}

export const NativeChatAgentReference = Node.create({
  name: 'nativeChatAgentReference',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({
    label: { default: '' },
    address: { default: '' },
    hostKey: { default: '' }
  }),
  addNodeView: () => ReactNodeViewRenderer(AgentReferencePill),
  renderText: ({ node }) =>
    agentReferenceToken({
      label: String(node.attrs.label),
      address: String(node.attrs.address),
      hostKey: String(node.attrs.hostKey)
    }),
  renderHTML: ({ node }) => [
    'span',
    { 'data-native-chat-agent-reference': node.attrs.address },
    `@${node.attrs.label}`
  ]
})

/** A draft holds each agent once: references already in it, or repeated in the list, are skipped. */
export function insertAgentReferences(
  editor: Editor,
  candidates: OrchestrationAgentReference[]
): void {
  if (!editor.isEditable) {
    return
  }
  const present = new Set<string>()
  editor.state.doc.descendants((node) => {
    if (node.type.name === NativeChatAgentReference.name) {
      present.add(`${node.attrs.hostKey}\0${node.attrs.address}`)
    }
  })
  const references = candidates.filter(({ hostKey, address }) => {
    const key = `${hostKey}\0${address}`
    return !present.has(key) && Boolean(present.add(key))
  })
  if (references.length === 0) {
    return
  }
  const nextNode = editor.state.selection.$to.nodeAfter
  const hasRightSeparator = nextNode?.isText
    ? /^\s/u.test(nextNode.text ?? '')
    : nextNode?.type.name === 'hardBreak'
  editor.view.dispatch(closeHistory(editor.state.tr))
  editor.commands.insertContent(
    references.flatMap((attrs, index) => [
      { type: NativeChatAgentReference.name, attrs },
      ...(index < references.length - 1 || !hasRightSeparator ? [{ type: 'text', text: ' ' }] : [])
    ])
  )
  editor.view.dispatch(closeHistory(editor.state.tr))
}
