import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react'
import { Package } from 'lucide-react'
import { NativeChatPromptPill } from './NativeChatPromptPill'

function skillLabel(token: string): string {
  return token
    .replace(/^[$/]/, '')
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(' ')
}

export function NativeChatSkillPill({ node, selected }: NodeViewProps): React.JSX.Element {
  const token = String(node.attrs.token)
  return (
    <NodeViewWrapper as="span" className="inline" contentEditable={false}>
      <NativeChatPromptPill
        icon={Package}
        label={skillLabel(token)}
        selected={selected}
        data-native-chat-skill={token}
      />
    </NodeViewWrapper>
  )
}
