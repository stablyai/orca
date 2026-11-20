import { useCallback, useEffect } from 'react'
import { useBotsEnabled } from '@/lib/bot-catalog'
import { parseCmdJTaskSourceUrl } from '@/lib/workspace/search/worktrees/worktree-palette-task-url-match'
import { advanceBotPaletteGeneration } from '@/components/bots/reveal-bot-sidebar-row'
import { openBotTemplates } from '@/components/bots/templates/bot-templates-open'
import type { BotScopeActionItem } from './worktree-jump-palette-model'
import type { WorktreeJumpPaletteLocalState } from './state/use-worktree-jump-palette-local-state'
import type { WorktreeJumpPaletteSelectionLifecycle } from './selection/use-worktree-jump-palette-selection-lifecycle'

// Typed into an empty field, either @ enters the bots-only scope; full-width ＠ is what CJK IMEs commit.
const SCOPE_TRIGGERS = new Set(['@', '＠'])

/** What "Search everything" puts back: a link as itself, so it opens as a link; other text with its @. */
export function botScopeRecoveryText(text: string): string {
  const trimmed = text.trim()
  return parseCmdJTaskSourceUrl(trimmed) ? trimmed : `@${text}`
}

type Input = Pick<
  WorktreeJumpPaletteLocalState,
  | 'scope'
  | 'setScope'
  | 'setScopeHeldQuery'
  | 'query'
  | 'liveQueryRef'
  | 'inputRef'
  | 'skipRestoreFocusRef'
> &
  Pick<WorktreeJumpPaletteSelectionLifecycle, 'handleQueryChange'> & { visible: boolean }

/** The @ scope: entering from a typed @, leaving on Backspace, and the two rows that switch it. */
export function useWorktreeJumpPaletteBotScope({
  visible,
  scope,
  setScope,
  setScopeHeldQuery,
  query,
  liveQueryRef,
  inputRef,
  skipRestoreFocusRef,
  handleQueryChange
}: Input) {
  const botsEnabled = useBotsEnabled()
  const scoped = scope === 'bots'

  const focusInputAtEnd = useCallback((): void => {
    const input = inputRef.current
    if (!input) {
      return
    }
    input.focus()
    // After the controlled value commits, so the caret lands after the restored text.
    requestAnimationFrame(() => input.setSelectionRange(input.value.length, input.value.length))
  }, [inputRef])

  const enterBotScope = useCallback(
    (text: string): void => {
      // The other sections keep searching what they had, so none of their work reruns while scoped.
      setScopeHeldQuery(liveQueryRef.current)
      setScope('bots')
      handleQueryChange(text)
      focusInputAtEnd()
    },
    [focusInputAtEnd, handleQueryChange, liveQueryRef, setScope, setScopeHeldQuery]
  )

  const leaveBotScope = useCallback(
    (restored: string): void => {
      setScope('all')
      handleQueryChange(restored)
      focusInputAtEnd()
    },
    [focusInputAtEnd, handleQueryChange, setScope]
  )

  // Bots turned off while scoped: back to everything, keeping what was typed.
  useEffect(() => {
    if (scoped && !botsEnabled) {
      leaveBotScope(`@${query}`)
    }
  }, [botsEnabled, leaveBotScope, query, scoped])

  // A palette opening supersedes any bot reveal still waiting from an earlier selection.
  useEffect(() => {
    if (visible) {
      advanceBotPaletteGeneration()
    }
  }, [visible])

  // Native listeners: cmdk's onValueChange carries only the string, not how it was typed. They sit on
  // the document while the palette is open, because the dialog mounts its field a commit after `visible`.
  useEffect(() => {
    if (!visible) {
      return
    }
    // The palette's own field, when the event is in it.
    const fieldOf = (event: Event): HTMLInputElement | null => {
      const input = inputRef.current
      return input && event.target === input ? input : null
    }
    let composingFromEmpty = false
    const onBeforeInput = (event: InputEvent): void => {
      const input = fieldOf(event)
      if (
        !input ||
        event.isComposing ||
        scoped ||
        !botsEnabled ||
        input.value !== '' ||
        event.inputType !== 'insertText' ||
        !SCOPE_TRIGGERS.has(event.data ?? '')
      ) {
        return
      }
      event.preventDefault()
      enterBotScope('')
    }
    const onCompositionStart = (event: CompositionEvent): void => {
      const input = fieldOf(event)
      composingFromEmpty = input !== null && input.value === '' && !scoped
    }
    const onCompositionEnd = (event: CompositionEvent): void => {
      if (fieldOf(event) && composingFromEmpty && botsEnabled && SCOPE_TRIGGERS.has(event.data)) {
        enterBotScope('')
      }
      composingFromEmpty = false
    }
    // Keydown sees the field before the key acts: the Backspace that empties it keeps the scope,
    // the next fresh press leaves, and a held Backspace (repeat) never does.
    const onKeyDown = (event: KeyboardEvent): void => {
      const input = fieldOf(event)
      if (
        !input ||
        !scoped ||
        event.key !== 'Backspace' ||
        event.isComposing ||
        event.keyCode === 229 ||
        event.repeat ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        input.value !== ''
      ) {
        return
      }
      event.preventDefault()
      leaveBotScope('')
    }
    document.addEventListener('beforeinput', onBeforeInput, true)
    document.addEventListener('compositionstart', onCompositionStart, true)
    document.addEventListener('compositionend', onCompositionEnd, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('beforeinput', onBeforeInput, true)
      document.removeEventListener('compositionstart', onCompositionStart, true)
      document.removeEventListener('compositionend', onCompositionEnd, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [botsEnabled, enterBotScope, inputRef, leaveBotScope, scoped, visible])

  /** The scope rows change what the palette searches, in place; only Browse templates leaves it. */
  const selectAction = useCallback(
    (action: BotScopeActionItem['action']): void => {
      if (action === 'show-everything') {
        leaveBotScope(botScopeRecoveryText(query))
      } else if (action === 'search-bots') {
        enterBotScope(query.trim())
      } else {
        // The templates dialog takes over the modal slot and focus; the palette mustn't restore over it.
        skipRestoreFocusRef.current = true
        openBotTemplates()
      }
    },
    [enterBotScope, leaveBotScope, query, skipRestoreFocusRef]
  )

  return { scoped, botsEnabled, enterBotScope, leaveBotScope, selectAction }
}

export type WorktreeJumpPaletteBotScope = ReturnType<typeof useWorktreeJumpPaletteBotScope>
