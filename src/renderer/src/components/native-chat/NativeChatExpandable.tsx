import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible'

/** Grows and shrinks its content so the rows around it move instead of jumping. Children
 *  mount only while open or closing, so open-only work belongs in a child component. */
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
