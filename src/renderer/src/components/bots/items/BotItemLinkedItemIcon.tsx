import { ListTodo } from 'lucide-react'
import type { BotItemLinkedItem } from '../../../../../shared/bots/bot-items'
import { BotItemStatusIcon } from './BotItemStatusIcon'

/** A linked item's glyph: its status, or a list mark when it can't be read. */
export function BotItemLinkedItemIcon({
  item
}: {
  item: BotItemLinkedItem | null
}): React.JSX.Element {
  return item ? (
    <BotItemStatusIcon status={item.status} />
  ) : (
    <ListTodo className="size-3.5 text-muted-foreground" />
  )
}
