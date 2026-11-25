import type { ListItem } from 'mdast'
import type { Extension as FromMarkdownExtension } from 'mdast-util-from-markdown'
import type { Processor } from 'unified'
import {
  keepTypedListItemNumber,
  type ListItemNumberStore
} from '../../../../../shared/markdown/chat-list-item-numbers'

const liValue: ListItemNumberStore<ListItem> = {
  read: (item) => item.data?.hProperties?.value,
  write: (item, typed) => {
    item.data = { ...item.data, hProperties: { ...item.data?.hProperties, value: String(typed) } }
  }
}

const listItemNumbersFromMarkdown: FromMarkdownExtension = {
  exit: {
    listItemValue(token) {
      const list = this.stack.at(-2)
      if (list?.type === 'list') {
        keepTypedListItemNumber(list, Number(this.sliceSerialize(token)), liValue)
      }
    }
  }
}

/** Chat items keep their typed numbers as `li[value]` instead of CommonMark's renumbering. */
export function remarkNativeChatListItemNumbers(this: Processor): void {
  ;(this.data().fromMarkdownExtensions ??= []).push(listItemNumbersFromMarkdown)
}
