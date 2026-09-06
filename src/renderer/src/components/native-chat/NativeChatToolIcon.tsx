import {
  Bot,
  Eye,
  Folder,
  Globe,
  ListChecks,
  Pencil,
  Plug,
  Search,
  SquareTerminal,
  Wrench
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  nativeChatToolIconName,
  type NativeChatToolIconName
} from '../../../../shared/native-chat-tool-icon'

/** Glyph name to component. */
const NATIVE_CHAT_TOOL_GLYPHS: Record<NativeChatToolIconName, LucideIcon> = {
  eye: Eye,
  search: Search,
  folder: Folder,
  'square-terminal': SquareTerminal,
  pencil: Pencil,
  globe: Globe,
  plug: Plug,
  bot: Bot,
  'list-checks': ListChecks,
  wrench: Wrench
}

/** The fixed 16px slot with a 14px glyph, which keeps every row left-aligned
 *  including rows whose category this vocabulary doesn't model. */
function NativeChatGlyphSlot({
  glyph: Glyph,
  className
}: {
  glyph: LucideIcon
  className?: string
}): React.JSX.Element {
  return (
    <span className={cn('flex size-4 shrink-0 items-center justify-center', className)}>
      <Glyph aria-hidden className="size-3.5" />
    </span>
  )
}

/**
 * The category glyph on a tool row. Decorative — the word beside it is the
 * accessible name — so it is `aria-hidden` and must never render without that
 * word.
 *
 * A running run header names one call and so resolves its glyph through this
 * same component, and can never disagree with the row it names.
 */
export function NativeChatToolIcon({
  rowWord,
  className
}: {
  /** The word the row renders, which is the row's whole identity. */
  rowWord: string
  className?: string
}): React.JSX.Element {
  return (
    <NativeChatGlyphSlot
      glyph={NATIVE_CHAT_TOOL_GLYPHS[nativeChatToolIconName(rowWord)]}
      className={className}
    />
  )
}

/**
 * The glyph over a settled run, which speaks for every call in it rather than
 * for one row, so its caller resolves the category and no row word names it.
 * Same table and same slot as a row's glyph, so the two can never draw one
 * category differently.
 */
export function NativeChatToolRunIcon({
  iconName,
  className
}: {
  iconName: NativeChatToolIconName
  className?: string
}): React.JSX.Element {
  return <NativeChatGlyphSlot glyph={NATIVE_CHAT_TOOL_GLYPHS[iconName]} className={className} />
}
