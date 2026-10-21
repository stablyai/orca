// The visual directive as a markdown block, for native-chat assistant prose only. The parser sees it
// like any other block (so code fences, indented code, quotes and lists keep their meaning), and the
// line itself is judged by the one shared grammar.

import type { Paragraph, Root, RootContent } from 'mdast'
import type { Extension as FromMarkdownExtension } from 'mdast-util-from-markdown'
import type {
  Code,
  Construct,
  Effects,
  Extension as MicromarkExtension,
  State,
  TokenizeContext
} from 'micromark-util-types'
import type { Processor } from 'unified'
import {
  NATIVE_CHAT_VISUAL_DIRECTIVE_MAX_LINE_LENGTH,
  NATIVE_CHAT_VISUAL_MAX_PER_MESSAGE,
  parseNativeChatVisualDirectiveLine
} from '../../../../shared/native-chat-visual-directive'

const TOKEN_TYPE = 'nativeChatVisual'
const COLON = 58
const HORIZONTAL_TAB = -2
const VIRTUAL_SPACE = -1

// Hast properties the placeholder carries through sanitize to the React component.
const NONCE_PROPERTY = 'dataOrcaVisual'
const FILE_PROPERTY = 'dataOrcaVisualFile'
const TITLE_PROPERTY = 'dataOrcaVisualTitle'
export const NATIVE_CHAT_VISUAL_PLACEHOLDER_PROPERTIES = [
  NONCE_PROPERTY,
  FILE_PROPERTY,
  TITLE_PROPERTY
] as const

export type NativeChatVisualNode = {
  type: 'nativeChatVisual'
  file: string
  title: string | null
  /** The line as written, for a directive shown as text instead. */
  source: string
  data?: { hName?: string; hProperties?: Record<string, string> }
}

declare module 'mdast' {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- declaration merging needs an interface.
  interface RootContentMap {
    nativeChatVisual: NativeChatVisualNode
  }
}

declare module 'micromark-util-types' {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- declaration merging needs an interface.
  interface TokenTypeMap {
    nativeChatVisual: 'nativeChatVisual'
  }
}

function tokenizeVisualLine(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  let line = ''
  const inside: State = (code: Code) => {
    // EOF, or a line ending (the negative codes below the tab/virtual-space codes).
    if (code === null || code < HORIZONTAL_TAB) {
      effects.exit(TOKEN_TYPE)
      return parseNativeChatVisualDirectiveLine(line) ? ok(code) : nok(code)
    }
    if (line.length >= NATIVE_CHAT_VISUAL_DIRECTIVE_MAX_LINE_LENGTH) {
      return nok(code)
    }
    if (code !== VIRTUAL_SPACE) {
      line += code === HORIZONTAL_TAB ? '\t' : String.fromCharCode(code)
    }
    effects.consume(code)
    return inside
  }
  return (code) => {
    effects.enter(TOKEN_TYPE)
    return inside(code)
  }
}

const visualLineConstruct: Construct = { name: TOKEN_TYPE, tokenize: tokenizeVisualLine }

const visualMicromarkExtension: MicromarkExtension = { flow: { [COLON]: visualLineConstruct } }

const visualFromMarkdown: FromMarkdownExtension = {
  enter: {
    [TOKEN_TYPE](token) {
      this.enter({ type: 'nativeChatVisual', file: '', title: null, source: '' }, token)
    }
  },
  exit: {
    [TOKEN_TYPE](token) {
      const node = this.stack.at(-1)
      const source = this.sliceSerialize(token)
      const directive = parseNativeChatVisualDirectiveLine(source)
      if (node?.type === 'nativeChatVisual' && directive) {
        node.file = directive.file
        node.title = directive.title
        node.source = source
      }
      this.exit(token)
    }
  }
}

function literalParagraph(node: NativeChatVisualNode): Paragraph {
  return { type: 'paragraph', children: [{ type: 'text', value: node.source }] }
}

type ChildList = { children: RootContent[] }

function hasChildren(node: RootContent): node is RootContent & ChildList {
  return 'children' in node && Array.isArray(node.children)
}

/**
 * Mounts only directives that stand alone at the top of the reply, up to the per-message cap. One
 * nested in a quote or list, or past the cap, reads as the text the agent wrote.
 */
function placeVisuals(
  parent: ChildList,
  isRoot: boolean,
  nonce: string,
  mounted: { count: number }
): void {
  parent.children = parent.children.map((child) => {
    if (child.type === 'nativeChatVisual') {
      if (!isRoot || mounted.count >= NATIVE_CHAT_VISUAL_MAX_PER_MESSAGE) {
        return literalParagraph(child)
      }
      mounted.count += 1
      child.data = {
        hName: 'div',
        hProperties: {
          [NONCE_PROPERTY]: nonce,
          [FILE_PROPERTY]: child.file,
          ...(child.title ? { [TITLE_PROPERTY]: child.title } : {})
        }
      }
      return child
    }
    if (hasChildren(child)) {
      placeVisuals(child, false, nonce, mounted)
    }
    return child
  })
}

/**
 * The remark plugin. `nonce` is unguessable per rendered message, so raw HTML in the reply cannot
 * forge a placeholder the component would mount.
 */
export function remarkNativeChatVisuals(this: Processor, nonce: string): (tree: Root) => void {
  const data = this.data()
  data.micromarkExtensions = [...(data.micromarkExtensions ?? []), visualMicromarkExtension]
  data.fromMarkdownExtensions = [...(data.fromMarkdownExtensions ?? []), visualFromMarkdown]
  return (tree) => placeVisuals(tree, true, nonce, { count: 0 })
}
