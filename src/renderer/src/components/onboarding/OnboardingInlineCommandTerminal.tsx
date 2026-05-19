import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Loader2 } from 'lucide-react'
import TerminalPane from '@/components/terminal-pane/TerminalPane'
import { PASTE_TERMINAL_TEXT_EVENT, type PasteTerminalTextDetail } from '@/constants/terminal'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { useAppStore } from '@/store'

const ONBOARDING_INLINE_TERMINAL_WORKTREE_ID = 'onboarding-inline-terminal'
const AUTO_INSERT_DELAY_MS = 700
const READY_RETRY_MS = 100
const READY_MAX_ATTEMPTS = 50

type OnboardingInlineCommandTerminalProps = {
  command: string
  title: string
  description: string
  ariaLabel: string
  onOpened?: () => void
  onInteracted?: (method: 'keyboard' | 'pointer', event?: KeyboardEvent<HTMLElement>) => void
}

export function OnboardingInlineCommandTerminal({
  command,
  title,
  description,
  ariaLabel,
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
    const tab = createTab(ONBOARDING_INLINE_TERMINAL_WORKTREE_ID, undefined, undefined, {
      activate: false
    })
    setActiveTabForWorktree(ONBOARDING_INLINE_TERMINAL_WORKTREE_ID, tab.id)
    setTabCustomTitle(tab.id, title)
    setTabId(tab.id)
  }, [createTab, setActiveTabForWorktree, setTabCustomTitle, title])

  useEffect(() => {
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
  }, [prefersReducedMotion])

  // Why: tracking scroll *during* the height transition is unavoidably
  // jumpy — ResizeObserver / rAF ticks land in pixel-sized chunks, and each
  // chunk reads as a step. Instead, let the section grow in place, then once
  // the height has nearly settled fire a single native smooth scroll. The
  // browser eases that scroll itself, which is the smoothest path available.
  useEffect(() => {
    if (!entered || prefersReducedMotion) {
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
  }, [entered, prefersReducedMotion])

  const insertCommand = useCallback(() => {
    if (!tabId) {
      return
    }
    terminalSectionRef.current?.scrollIntoView({
      behavior: 'auto',
      block: 'nearest'
    })
    window.dispatchEvent(
      new CustomEvent<PasteTerminalTextDetail>(PASTE_TERMINAL_TEXT_EVENT, {
        detail: {
          tabId,
          text: command.trim()
        }
      })
    )
    focusTerminalTabSurface(tabId)
  }, [command, tabId])

  useEffect(() => {
    if (!tabId || autoInsertedRef.current === command) {
      return
    }
    let canceled = false
    let insertionTimer: number | null = null

    const waitForTerminal = (attempt: number): void => {
      if (canceled) {
        return
      }
      if (findTerminalTabElement(tabId)?.querySelector('[data-pty-id]')) {
        insertionTimer = window.setTimeout(() => {
          if (!canceled) {
            autoInsertedRef.current = command
            insertCommand()
          }
        }, AUTO_INSERT_DELAY_MS)
        return
      }
      if (attempt < READY_MAX_ATTEMPTS) {
        window.setTimeout(() => waitForTerminal(attempt + 1), READY_RETRY_MS)
      }
    }

    waitForTerminal(0)
    return () => {
      canceled = true
      if (insertionTimer !== null) {
        window.clearTimeout(insertionTimer)
      }
    }
  }, [command, insertCommand, tabId])

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
        marginTop: entered ? 20 : 0
      }}
    >
      <section
        ref={terminalSectionRef}
        aria-label={ariaLabel}
        className="min-h-0 overflow-hidden rounded-xl border border-border bg-card"
      >
        <div className="border-b border-border px-4 py-3">
          <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
        </div>
        <div
          className="relative h-[280px] min-h-0 bg-background"
          onKeyDownCapture={(event) => onInteracted?.('keyboard', event)}
          onPointerDownCapture={() => onInteracted?.('pointer')}
        >
          {cwd && tabId ? (
            <TerminalPane
              tabId={tabId}
              worktreeId={ONBOARDING_INLINE_TERMINAL_WORKTREE_ID}
              cwd={cwd}
              isActive
              isVisible
              onPtyExit={() => closeTab(tabId)}
              onCloseTab={() => closeTab(tabId)}
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
