import { translate } from '@/i18n/i18n'

export function ConversationKnowledgeResizeHandle({
  isResizing,
  onResizeStart
}: {
  isResizing: boolean
  onResizeStart: React.MouseEventHandler<HTMLDivElement>
}): React.JSX.Element {
  return (
    <div
      aria-label={translate('conversationKnowledge.detail.resize', 'Resize details')}
      className={`absolute -left-1.5 top-0 z-20 flex h-full w-3 cursor-col-resize items-stretch justify-center ${isResizing ? 'bg-ring/10' : ''}`}
      onMouseDown={onResizeStart}
      role="separator"
    >
      <div className={`h-full w-px ${isResizing ? 'bg-ring' : 'bg-border'}`} />
    </div>
  )
}
