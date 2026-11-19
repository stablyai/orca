import type { Extension as FromMarkdownExtension } from 'mdast-util-from-markdown'
import type { Processor } from 'unified'

const listItemNumbersFromMarkdown: FromMarkdownExtension = {
  exit: {
    listItemValue(token) {
      const item = this.stack.at(-1)
      if (item?.type === 'listItem') {
        item.data = {
          ...item.data,
          hProperties: { ...item.data?.hProperties, value: this.sliceSerialize(token) }
        }
      }
    }
  }
}

/** Chat means typed numbers literally ("4." is step 4), so items keep them instead of CommonMark's renumbering. */
export function remarkNativeChatListItemNumbers(this: Processor): void {
  ;(this.data().fromMarkdownExtensions ??= []).push(listItemNumbersFromMarkdown)
}
