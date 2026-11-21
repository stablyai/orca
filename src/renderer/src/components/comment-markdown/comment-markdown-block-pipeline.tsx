import React from 'react'
import Markdown from 'react-markdown'
import { unified, type Processor } from 'unified'
import remarkParse from 'remark-parse'
import type { CommentMarkdownExtension } from './CommentMarkdown'
import { useChatMathRendering } from './chat-markdown-math-rendering'
import { rehypeWordFade } from './comment-markdown-word-fade'
import {
  splitMarkdownTopLevelBlocks,
  type HtmlRendersAsText,
  type MarkdownBlock,
  type MarkdownBlockSplit
} from './markdown-top-level-blocks'

type RemarkPlugins = NonNullable<React.ComponentProps<typeof Markdown>['remarkPlugins']>
type RehypePlugins = NonNullable<React.ComponentProps<typeof Markdown>['rehypePlugins']>

type MemoizedMarkdownProps = React.ComponentProps<typeof Markdown> & {
  math: boolean
  /** Source offset in this block where fading words start; none renders plain. */
  fadeFrom?: number
  /** The block no longer grows: while it fades it keeps the fade point it first rendered with, so
   *  steps don't re-run its pipeline. Its words finish fading on their own. */
  fadeSettled?: boolean
  /** Block offsets of selected fading words, whose groups keep their word elements. */
  fadeHoldFrom?: number
  fadeHoldTo?: number
  /** Where this block starts in the whole content. */
  fadeBase?: number
  block?: MarkdownBlock
}

/** Equal props, except that a settled block's moving fade point doesn't count until it renders plain. */
function sameBlockRender(previous: MemoizedMarkdownProps, next: MemoizedMarkdownProps): boolean {
  const { fadeFrom: before, ...previousRest } = previous
  const { fadeFrom: after, ...nextRest } = next
  const holdsFade = next.fadeSettled === true && before !== undefined && after !== undefined
  if (before !== after && !holdsFade) {
    return false
  }
  const previousEntries = Object.entries(previousRest)
  const nextValues = new Map(Object.entries(nextRest))
  return (
    previousEntries.length === nextValues.size &&
    previousEntries.every(
      ([key, value]) => nextValues.has(key) && Object.is(nextValues.get(key), value)
    )
  )
}

/** One render of the pipeline; memoized so an unchanged block is not parsed again. */
export const MemoizedMarkdown = React.memo(function DeferredMarkdown({
  math,
  fadeFrom,
  fadeSettled: _settled,
  fadeHoldFrom,
  fadeHoldTo,
  fadeBase = 0,
  block,
  ...props
}: MemoizedMarkdownProps) {
  const renderMath = useChatMathRendering(math)
  const plugins = React.useMemo<RehypePlugins>(
    () => [
      ...(props.rehypePlugins ?? []),
      ...(math ? [renderMath] : []),
      ...(fadeFrom === undefined
        ? []
        : [
            [
              rehypeWordFade,
              {
                from: fadeFrom,
                base: fadeBase,
                ...(fadeHoldFrom !== undefined && fadeHoldTo !== undefined
                  ? { hold: { from: fadeHoldFrom, to: fadeHoldTo } }
                  : {})
              }
            ] satisfies RehypePlugins[number]
          ])
    ],
    [props.rehypePlugins, math, renderMath, fadeFrom, fadeHoldFrom, fadeHoldTo, fadeBase]
  )
  const parsedPlugins = React.useMemo<RemarkPlugins>(() => {
    if (!block?.tree) {
      return props.remarkPlugins ?? []
    }
    const tree = block.tree
    const source = markdownBlockContent(block)
    // Transforms mutate mdast; each render owns a fresh copy of the pristine parse.
    function reuseParsedBlock(this: Processor): void {
      const parse = this.parser
      if (!parse) {
        return
      }
      this.parser = (value, file) => (value === source ? structuredClone(tree) : parse(value, file))
    }
    return [...(props.remarkPlugins ?? []), reuseParsedBlock]
  }, [block, props.remarkPlugins])
  return <Markdown {...props} remarkPlugins={parsedPlugins} rehypePlugins={plugins} />
}, sameBlockRender)

/** The content as the blocks to render. Cut into blocks from the first time it is growing, and
 *  from then on, so the stream ending does not redraw what is already there. */
export function useMarkdownBlocks(
  content: string,
  growing: boolean,
  math: boolean,
  plugins: RemarkPlugins,
  extension?: CommentMarkdownExtension,
  rendersAsText?: HtmlRendersAsText
): readonly MarkdownBlock[] {
  const parser = React.useMemo(() => unified().use(remarkParse).use(plugins), [plugins])
  const [state, setState] = React.useState<{
    parser: typeof parser
    rendersAsText?: HtmlRendersAsText
    split: MarkdownBlockSplit
  } | null>(null)
  // Cuts made while some HTML rendered as text do not hold once it is raw.
  const kept = state?.rendersAsText === rendersAsText ? state : null
  if (kept && kept.parser !== parser) {
    const split = {
      ...kept.split,
      blocks: kept.split.blocks.map(({ tree: _tree, closedFence: _closedFence, ...block }) => block)
    }
    setState({ parser, rendersAsText, split })
    return split.blocks
  }
  const previous = kept?.split ?? null
  if (!growing && kept === null) {
    return [{ start: 0, line: 1, text: content }]
  }
  if (previous?.source === content) {
    return previous.blocks
  }
  const markers = extension?.extraFlowSyntaxMarkers
  const knownGrammar = !extension?.remarkPlugins.length || markers !== undefined
  const next = splitMarkdownTopLevelBlocks(
    content,
    previous,
    math,
    knownGrammar ? (source) => parser.parse(source) : undefined,
    (tail) => !content.includes('\uFEFF') && !markers?.some((marker) => tail.includes(marker)),
    rendersAsText
  )
  setState({ parser, rendersAsText, split: next })
  return next.blocks
}

export function markdownBlockContent(block: MarkdownBlock): string {
  return block.literalMath && block.end !== undefined
    ? block.text.slice(0, block.end - block.start)
    : block.text
}
