import { useMemo } from 'react'
import type { Worktree } from '../../../../shared/worktree/types'
import { useBotPaletteSource } from '@/components/bots/bot-palette-source'
import { useBotTemplatePaletteSource } from '@/components/bots/templates/bot-template-palette-source'
import type { PaletteExtraSource } from './palette-extra-results'

/** Each source registers here with its own hook; return a memoized list. */
export function usePaletteExtraSources({
  query,
  visible,
  scoped
}: {
  query: string
  visible: boolean
  /** Showing only bots: template suggestions stay idle. */
  scoped: boolean
}): {
  sources: readonly PaletteExtraSource[]
  /** Workspaces any source lists as itself; stable while the sources' own predicates are. */
  hidesWorkspace: ((worktree: Worktree) => boolean) | null
} {
  const bots = useBotPaletteSource({ query, visible })
  const templates = useBotTemplatePaletteSource({ query, visible: visible && !scoped })
  const sources = useMemo(
    () => [bots, templates].filter((source): source is PaletteExtraSource => source !== null),
    [bots, templates]
  )
  // Keyed by the predicates, not the results, so a keystroke that only changes bot rows keeps it.
  const botHides = bots?.hidesWorkspace
  const templateHides = templates?.hidesWorkspace
  const hidesWorkspace = useMemo(() => {
    const predicates = [botHides, templateHides].filter(
      (predicate): predicate is (worktree: Worktree) => boolean => predicate !== undefined
    )
    return predicates.length
      ? (worktree: Worktree) => predicates.some((predicate) => predicate(worktree))
      : null
  }, [botHides, templateHides])
  return { sources, hidesWorkspace }
}
