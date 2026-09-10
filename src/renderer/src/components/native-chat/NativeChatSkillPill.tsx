import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react'
import { Package } from 'lucide-react'
import { Badge } from '@/components/ui/badge'

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
      <Badge
        variant="secondary"
        data-native-chat-skill={token}
        className={`gap-1 border-border px-1.5 py-0 text-sm font-medium text-muted-foreground align-baseline ${selected ? 'ring-1 ring-ring' : ''}`}
      >
        <Package className="size-4" aria-hidden="true" />
        {skillLabel(token)}
      </Badge>
    </NodeViewWrapper>
  )
}
