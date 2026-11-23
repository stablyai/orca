import {
  Node,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type Editor,
  type NodeViewProps
} from '@tiptap/react'
import { SquareTerminal, Users } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { AgentTypeIcon } from '@/components/agent/icons/agent-type-icon'
import { NativeChatPromptPill } from './NativeChatPromptPill'
import {
  agentReferenceToken,
  type OrchestrationAgentReference
} from '../../../../../../shared/orchestration/mailbox/orchestration-agent-reference'
import { closeHistory } from '@tiptap/pm/history'

function AgentReferencePill({ node, selected }: NodeViewProps): React.JSX.Element {
  const t = useTranslate()
  const label = String(node.attrs.label)
  const agentType = String(node.attrs.agentType ?? '')
  const terminal = node.attrs.kind === 'terminal'
  return (
    <NodeViewWrapper
      as="span"
      className="inline"
      contentEditable={false}
      data-native-chat-agent-reference={node.attrs.address}
    >
      <NativeChatPromptPill
        icon={terminal ? SquareTerminal : Users}
        // The agent's logo where it was picked from a list that knows it; older drafts keep the generic icon.
        avatar={
          agentType ? (
            <AgentTypeIcon agentType={agentType} size={12} className="size-3" />
          ) : undefined
        }
        label={label}
        spokenLabel={
          terminal
            ? t('components.native-chat.composer.terminalPillLabel', 'Terminal: {{name}}', {
                name: label
              })
            : t('components.native-chat.composer.agentPillLabel', 'Agent: {{name}}', {
                name: label
              })
        }
        selected={selected}
      />
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
    hostKey: { default: '' },
    kind: { default: '' },
    agentType: { default: '' }
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
  const { $to } = editor.state.selection
  const nextNode = $to.nodeAfter
  const endsNonFinalLine =
    !nextNode && $to.depth > 0 && $to.after(1) < editor.state.doc.content.size
  const hasRightSeparator = nextNode?.isText ? /^\s/u.test(nextNode.text ?? '') : endsNonFinalLine
  editor.view.dispatch(closeHistory(editor.state.tr))
  editor.commands.insertContent(
    references.flatMap((attrs, index) => [
      {
        type: NativeChatAgentReference.name,
        attrs: { ...attrs, agentType: attrs.agentType ?? '' }
      },
      ...(index < references.length - 1 || !hasRightSeparator ? [{ type: 'text', text: ' ' }] : [])
    ])
  )
  editor.view.dispatch(closeHistory(editor.state.tr))
}
