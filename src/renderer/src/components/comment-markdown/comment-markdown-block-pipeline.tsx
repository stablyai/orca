import React from 'react'
import Markdown from 'react-markdown'
import { unified, type Processor } from 'unified'
import remarkParse from 'remark-parse'
import type { CommentMarkdownExtension, CommentMarkdownBlockPreparer } from './CommentMarkdown'
import { useChatMathRendering } from './chat-markdown-math-rendering'
import { rehypeWordFade } from './comment-markdown-word-fade'
import {
  splitMarkdownTopLevelBlocks,
  markdownBlockContent,
  type HtmlRendersAsText,
  type MarkdownBlock,
  type MarkdownBlockSplit
} from './markdown-top-level-blocks'
export { markdownBlockContent } from './markdown-top-level-blocks'

type RemarkPlugins = NonNullable<React.ComponentProps<typeof Markdown>['remarkPlugins']>

/** One render of the pipeline; memoized so an unchanged block is not parsed again. */
export const MemoizedMarkdown = React.memo(function DeferredMarkdown({
  math,
  fadeWords,
  block,
  sourceStart = 0,
  growingTail = false,
  prepareBlock,
  ...props
}: React.ComponentProps<typeof Markdown> & {
  math: boolean
  fadeWords: boolean
  block?: MarkdownBlock
  sourceStart?: number
  growingTail?: boolean
  prepareBlock?: CommentMarkdownBlockPreparer
}) {
  const prepared = React.useMemo(
    () =>
      prepareBlock?.({
        content: props.children ?? '',
        start: sourceStart,
        growing: growingTail,
        remarkPlugins: props.remarkPlugins ?? [],
        rehypePlugins: props.rehypePlugins ?? [],
        remarkRehypeOptions: props.remarkRehypeOptions
      }),
    [
      prepareBlock,
      props.children,
      sourceStart,
      growingTail,
      props.remarkPlugins,
      props.rehypePlugins,
      props.remarkRehypeOptions
    ]
  )
  const markdownProps = { ...props, ...prepared?.props }
  const renderMath = useChatMathRendering(math)
  const plugins = React.useMemo(
    () => [
      ...(markdownProps.rehypePlugins ?? []),
      ...(math ? [renderMath] : []),
      ...(fadeWords ? [rehypeWordFade] : []),
      ...(prepared?.afterRehypePlugins ?? [])
    ],
    [markdownProps.rehypePlugins, math, renderMath, fadeWords, prepared?.afterRehypePlugins]
  )
  const parsedPlugins = React.useMemo<RemarkPlugins>(() => {
    if (!block?.tree) {
      return markdownProps.remarkPlugins ?? []
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
    return [...(markdownProps.remarkPlugins ?? []), reuseParsedBlock]
  }, [block, markdownProps.remarkPlugins])
  const element = (
    <Markdown {...markdownProps} remarkPlugins={parsedPlugins} rehypePlugins={plugins} />
  )
  return prepared?.wrap ? prepared.wrap(element) : element
})

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
