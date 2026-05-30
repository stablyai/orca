import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Loader2 } from 'lucide-react'
import TerminalPane from '@/components/terminal-pane/TerminalPane'
import { PASTE_TERMINAL_TEXT_EVENT, type PasteTerminalTextDetail } from '@/constants/terminal'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { useAppStore } from '@/store'

const ONBOARDING_INLINE_TERMINAL_WORKTREE_ID = 'onboarding-inline-terminal'
const AUTO_INSERT_DELAY_MS = 250
const READY_RETRY_MS = 100
const PTY_TEXT_FALLBACK_MS = 750

type OnboardingInlineCommandTerminalProps = {
  command: string
  title: string
  description?: string
  ariaLabel: string
  terminalHeightPx?: number
  terminalTopMarginPx?: number
  descriptionPaddingClassName?: string
  autoScrollIntoView?: boolean
  worktreeId?: string
  onOpened?: () => void
  onInteracted?: (method: 'keyboard' | 'pointer', event?: KeyboardEvent<HTMLElement>) => void
}

export function OnboardingInlineCommandTerminal({
  command,
  title,
  description,
  ariaLabel,
  terminalHeightPx = 280,
  terminalTopMarginPx = 20,
  descriptionPaddingClassName = 'px-4 py-3',
  autoScrollIntoView = true,
  worktreeId = ONBOARDING_INLINE_TERMINAL_WORKTREE_ID,
  onOpened,
  onInteracted
}: OnboardingInlineCommandTerminalProps): React.JSX.Element {
  const createTab = useAppStore((s) => s.createTab)
  const closeTab = useAppStore((s) => s.closeTab)
  const setActiveTabForWorktree = useAppStore((s) => s.setActiveTabForWorktree)
  const setTabCustomTitle = useAppStore((s) => s.setTabCustomTitle)
  const prefersReducedMotion = useMemo(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    []
  )
  const [cwd, setCwd] = useState<string | null>(null)
  const [tabId, setTabId] = useState<string | null>(null)
  // Why: starts at `prefersReducedMotion` so users opted out of motion never
  // see the slide-in frame; otherwise we flip to true after first paint so the
  // CSS transition has a starting state to interpolate from.
  const [entered, setEntered] = useState(prefersReducedMotion)
  const terminalSectionRef = useRef<HTMLElement>(null)
  const autoInsertedRef = useRef<string | null>(null)

  useEffect(() => {
    onOpened?.()
  }, [onOpened])

  useEffect(() => {
    void window.api.app.getFloatingTerminalCwd({ path: '~' }).then(setCwd)
  }, [])

  useEffect(() => {
    const tab = createTab(worktreeId, undefined, undefined, {
      activate: false,
      recordInteraction: false
    })
    setActiveTabForWorktree(worktreeId, tab.id)
    setTabCustomTitle(tab.id, title, { recordInteraction: false })
    setTabId(tab.id)
    return () => {
      // Why: inline setup panels can disappear after detection succeeds; close
      // the backing tab so installer shells do not keep running invisibly.
      closeTab(tab.id, { recordInteraction: false })
    }
  }, [closeTab, createTab, setActiveTabForWorktree, setTabCustomTitle, title, worktreeId])

  useEffect(() => {
    if (!autoScrollIntoView) {
      return
    }
    if (prefersReducedMotion) {
      const scrollFrame = window.requestAnimationFrame(() => {
        terminalSectionRef.current?.scrollIntoView({ behavior: 'auto', block: 'center' })
      })
      return () => window.cancelAnimationFrame(scrollFrame)
    }
    // Why: double rAF guarantees the browser commits the initial collapsed
    // styles before we flip to `entered`, so the height/opacity transition
    // actually plays instead of snapping straight to the final state.
    const enterFrame = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => setEntered(true))
    })
    return () => window.cancelAnimationFrame(enterFrame)
  }, [autoScrollIntoView, prefersReducedMotion])

  useEffect(() => {
    if (autoScrollIntoView) {
      return
    }
    const enterFrame = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => setEntered(true))
    })
    return () => window.cancelAnimationFrame(enterFrame)
  }, [autoScrollIntoView])

  // Why: tracking scroll *during* the height transition is unavoidably
  // jumpy — ResizeObserver / rAF ticks land in pixel-sized chunks, and each
  // chunk reads as a step. Instead, let the section grow in place, then once
  // the height has nearly settled fire a single native smooth scroll. The
  // browser eases that scroll itself, which is the smoothest path available.
  useEffect(() => {
    if (!autoScrollIntoView || !entered || prefersReducedMotion) {
      return
    }
    const section = terminalSectionRef.current
    if (!section) {
      return
    }
    const scrollTimer = window.setTimeout(() => {
      section.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 500)
    return () => window.clearTimeout(scrollTimer)
  }, [autoScrollIntoView, entered, prefersReducedMotion])

  const insertCommand = useCallback(() => {
    if (!tabId) {
      return
    }
    if (autoScrollIntoView) {
      terminalSectionRef.current?.scrollIntoView({
        behavior: 'auto',
        block: 'nearest'
      })
    }
    window.dispatchEvent(
      new CustomEvent<PasteTerminalTextDetail>(PASTE_TERMINAL_TEXT_EVENT, {
        detail: {
          tabId,
          text: command.trim()
        }
      })
    )
    focusTerminalTabSurface(tabId)
  }, [autoScrollIntoView, command, tabId])

  useEffect(() => {
    if (!tabId || !cwd || autoInsertedRef.current === command) {
      return
    }
    let canceled = false
    let insertionTimer: number | null = null
    let retryTimer: number | null = null
    let ptyFirstSeenAt: number | null = null

    const scheduleInsert = (): void => {
      if (insertionTimer !== null) {
        return
      }
      insertionTimer = window.setTimeout(() => {
        if (!canceled) {
          autoInsertedRef.current = command
          insertCommand()
        }
      }, AUTO_INSERT_DELAY_MS)
    }

    const waitForTerminal = (): void => {
      if (canceled) {
        return
      }
      const terminalElement = findTerminalTabElement(tabId)
      const hasPty = Boolean(terminalElement?.querySelector('[data-pty-id]'))
      if (terminalReadyForCommand(terminalElement)) {
        scheduleInsert()
        return
      }
      if (hasPty) {
        ptyFirstSeenAt ??= Date.now()
        // Why: GPU/canvas terminal renderers may not expose visible prompt text
        // in .xterm-rows. Once the PTY has settled briefly, paste the draft
        // instead of waiting on a DOM signal that may never arrive.
        if (Date.now() - ptyFirstSeenAt >= PTY_TEXT_FALLBACK_MS) {
          scheduleInsert()
          return
        }
      } else {
        ptyFirstSeenAt = null
      }
      retryTimer = window.setTimeout(waitForTerminal, READY_RETRY_MS)
    }

    waitForTerminal()
    return () => {
      canceled = true
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer)
      }
      if (insertionTimer !== null) {
        window.clearTimeout(insertionTimer)
      }
    }
  }, [command, cwd, insertCommand, tabId])

  // Why: grid 0fr → 1fr animates to the child's natural height without a
  // hardcoded max-height, so we don't leave dead space if the terminal
  // section's intrinsic size shifts. The inner section is positioned via the
  // grid row, so xterm.js measures its real container on mount.
  return (
    <div
      aria-hidden={!entered}
      className="grid transition-[grid-template-rows,opacity,margin-top] duration-[700ms] ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none"
      style={{
        gridTemplateRows: entered ? '1fr' : '0fr',
        opacity: entered ? 1 : 0,
        marginTop: entered ? terminalTopMarginPx : 0
      }}
    >
      <section
        ref={terminalSectionRef}
        aria-label={ariaLabel}
        className="min-h-0 overflow-hidden rounded-xl border border-border bg-card"
      >
        {description ? (
          <div className={`border-b border-border ${descriptionPaddingClassName}`}>
            <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
          </div>
        ) : null}
        <div
          className="relative min-h-0 bg-background"
          style={{ height: terminalHeightPx }}
          onKeyDownCapture={(event) => onInteracted?.('keyboard', event)}
          onPointerDownCapture={() => onInteracted?.('pointer')}
        >
          {cwd && tabId ? (
            <TerminalPane
              tabId={tabId}
              worktreeId={worktreeId}
              cwd={cwd}
              isActive
              isVisible
              onPtyExit={() => closeTab(tabId, { recordInteraction: false })}
              onCloseTab={() => closeTab(tabId, { recordInteraction: false })}
            />
          ) : (
            <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Starting terminal...
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

function findTerminalTabElement(tabId: string): HTMLElement | null {
  for (const element of document.querySelectorAll<HTMLElement>('[data-terminal-tab-id]')) {
    if (element.dataset.terminalTabId === tabId) {
      return element
    }
  }
  return null
}

function terminalReadyForCommand(element: HTMLElement | null): boolean {
  if (!element?.querySelector('[data-pty-id]')) {
    return false
  }
  // Why: pasting before the login shell renders a prompt can double-echo the
  // draft command. Visible terminal text is the least intrusive readiness signal.
  const renderedText = element.querySelector('.xterm-rows')?.textContent?.trim() ?? ''
  return renderedText.length > 0
}
