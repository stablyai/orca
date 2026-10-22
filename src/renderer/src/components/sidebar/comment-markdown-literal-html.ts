import type { Extension } from 'micromark-util-types'
import type { Processor } from 'unified'

// Why the parser, not the tree: an HTML block swallows the lines after it, so their markdown
// would stay raw even if the block were turned back into text afterwards.
const disableHtml: Extension = { disable: { null: ['htmlFlow', 'htmlText'] } }

/** Why: a person's prompt is what they typed; `<se-tabs>` there is words, not markup to sanitize away. */
export function remarkLiteralHtml(this: Processor): void {
  const data = this.data()
  data.micromarkExtensions = [...(data.micromarkExtensions ?? []), disableHtml]
}
