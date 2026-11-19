import React from 'react'
import Markdown from 'react-markdown'
import { unified, type Processor } from 'unified'
import remarkParse from 'remark-parse'
import type { CommentMarkdownExtension } from './CommentMarkdown'
import { useChatMathRendering } from './chat-markdown-math-rendering'
import { rehypeWordFade } from './comment-markdown-word-fade'
import {
  definitionContext,
  footnoteReferences,
  hasLinkReference,
  rehypeDropFootnoteSeed,
  remarkBlockReferences,
  type MarkdownBlockReferences,
  type MarkdownDefinition
} from './markdown-block-definitions'
import {
  splitMarkdownTopLevelBlocks,
  type HtmlRendersAsText,
  type MarkdownBlock,
  type MarkdownBlockSplit
} from './markdown-top-level-blocks'

type RemarkPlugins = NonNullable<React.ComponentProps<typeof Markdown>['remarkPlugins']>

/** One render of the pipeline; memoized so an unchanged block is not parsed again. */
export const MemoizedMarkdown = React.memo(function DeferredMarkdown({
  math,
  fadeWords,
  block,
  references,
  footer = false,
  ...props
}: React.ComponentProps<typeof Markdown> & {
  math: boolean
  fadeWords: boolean
  block?: MarkdownBlock
  /** What this block needs from the rest of the document. */
  references?: MarkdownBlockReferences
  /** Renders the document's footnotes. */
  footer?: boolean
}) {
  const renderMath = useChatMathRendering(math)
  const plugins = React.useMemo(
    () => [
      ...(references ? [rehypeDropFootnoteSeed] : []),
      ...(props.rehypePlugins ?? []),
      ...(math ? [renderMath] : []),
      ...(fadeWords ? [rehypeWordFade] : [])
    ],
    [props.rehypePlugins, math, renderMath, fadeWords, references]
  )
  const parsedPlugins = React.useMemo<RemarkPlugins>(() => {
    const withReferences = [
      ...(props.remarkPlugins ?? []),
      ...(references ? [remarkBlockReferences(references, footer)] : [])
    ]
    if (!block?.tree) {
      return withReferences
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
    return [...withReferences, reuseParsedBlock]
  }, [block, props.remarkPlugins, references, footer])
  return <Markdown {...props} remarkPlugins={parsedPlugins} rehypePlugins={plugins} />
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
): Pick<MarkdownBlockSplit, 'blocks' | 'definitions'> {
  const parser = React.useMemo(() => unified().use(remarkParse).use(plugins), [plugins])
  const [state, setState] = React.useState<{
    parser: typeof parser
    rendersAsText?: HtmlRendersAsText
    split: MarkdownBlockSplit
  } | null>(null)
  // Cuts made while some HTML rendered as text do not hold once it is raw.
  const kept = state?.rendersAsText === rendersAsText ? state : null
  // Kept cuts lose their trees; with definitions, numbering needs them, so split again instead.
  if (kept && kept.parser !== parser && kept.split.definitions.length === 0) {
    const split = {
      ...kept.split,
      blocks: kept.split.blocks.map(({ tree: _tree, closedFence: _closedFence, ...block }) => block)
    }
    setState({ parser, rendersAsText, split })
    return split
  }
  const previous = kept?.parser === parser ? kept.split : null
  if (!growing && kept === null) {
    return { blocks: [{ start: 0, line: 1, text: content }], definitions: [] }
  }
  if (previous?.source === content) {
    return previous
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
  return next
}

type BlockReferenceUse = { footnotes: readonly { identifier: string; label: string }[]; links: boolean }
const referenceUses = new WeakMap<object, BlockReferenceUse>()

function blockReferenceUse(block: MarkdownBlock): BlockReferenceUse {
  if (!block.tree) {
    return { footnotes: [], links: block.text.includes('[') }
  }
  let use = referenceUses.get(block.tree)
  if (!use) {
    use = {
      footnotes: footnoteReferences(block.tree).map(({ identifier, label }) => ({
        identifier,
        label: label ?? identifier
      })),
      links: hasLinkReference(block.tree)
    }
    referenceUses.set(block.tree, use)
  }
  return use
}

/** Each block's share of the document's definitions and footnote numbering, kept identical while
 *  it is unchanged so settled blocks stay memoized; and the footnotes footer, when any. */
export function useMarkdownBlockReferences(
  blocks: readonly MarkdownBlock[],
  definitions: readonly MarkdownDefinition[]
): {
  blocks: readonly (MarkdownBlockReferences | undefined)[]
  context: string
  footer?: { source: string; references: MarkdownBlockReferences }
} {
  const cache = React.useRef(new Map<string, MarkdownBlockReferences>())
  if (definitions.length === 0) {
    return { blocks: [], context: '' }
  }
  const previous = cache.current
  const next = new Map<string, MarkdownBlockReferences>()
  const linkDefinitions = definitions.flatMap((definition) =>
    definition.node ? [definition.node] : []
  )
  const linkKey = linkDefinitions.length > 0 ? definitions.map((d) => d.source).join('\n') : ''
  const remember = (key: string, make: () => MarkdownBlockReferences): MarkdownBlockReferences => {
    const kept = next.get(key) ?? previous.get(key) ?? make()
    next.set(key, kept)
    return kept
  }
  const order: { identifier: string; label: string; count: number }[] = []
  const position = new Map<string, number>()
  const perBlock = blocks.map((block) => {
    const use = blockReferenceUse(block)
    const links = use.links && linkDefinitions.length > 0
    if (!links && use.footnotes.length === 0) {
      return undefined
    }
    const seed = order.map((entry) => ({ ...entry }))
    for (const { identifier, label } of use.footnotes) {
      const at = position.get(identifier)
      if (at === undefined) {
        position.set(identifier, order.length)
        order.push({ identifier, label, count: 1 })
      } else {
        order[at]!.count += 1
      }
    }
    const key = `${links ? linkKey : ''}|${JSON.stringify(seed)}`
    return remember(key, () => ({ links: links ? linkDefinitions : [], seed }))
  })
  cache.current = next
  const footnoteSources = definitions
    .filter((definition) => definition.kind === 'footnote')
    .map((definition) => definition.source)
  const footer =
    order.length > 0 && footnoteSources.length > 0
      ? {
          source: footnoteSources.join('\n\n'),
          references: remember(`footer|${linkKey}|${JSON.stringify(order)}`, () => ({
            links: linkDefinitions,
            seed: order
          }))
        }
      : undefined
  return { blocks: perBlock, context: definitionContext(definitions), ...(footer ? { footer } : {}) }
}

export function markdownBlockContent(block: MarkdownBlock): string {
  return block.literalMath && block.end !== undefined
    ? block.text.slice(0, block.end - block.start)
    : block.text
}
