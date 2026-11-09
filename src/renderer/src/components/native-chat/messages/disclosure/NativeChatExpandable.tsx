import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible'

/** Mount children only while open or closing; keep open-only work inside a child component. */
export function NativeChatExpandable({
  open,
  children
}: {
  open: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Collapsible open={open}>
      <CollapsibleContent animation="height" data-native-chat-member-detail>
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
}
