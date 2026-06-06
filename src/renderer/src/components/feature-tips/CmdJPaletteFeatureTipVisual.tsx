import { useEffect, useState, type JSX } from 'react'
import { Loader2, Plus, Search } from 'lucide-react'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion'
import { useShortcutKeys } from '@/hooks/useShortcutLabel'

const TYPED_QUERY = 'auth-pr'
// Why: one finished + one still running mirrors what a user actually sees in
// the palette (mixed agent states), making the tip's value visible at a glance.
const WORKTREE_RESULTS: readonly {
  key: string
  name: string
  status: 'done' | 'running'
  chip: string | null
}[] = [
  { key: '1', name: 'auth-pr-1', status: 'done', chip: 'Current' },
  { key: '2', name: 'auth-pr-2', status: 'running', chip: 'Running' }
]

// Why: cycle phases are sequenced so the keypress visibly precedes the palette
// opening (cause → effect), matching what the user will see when they actually
// press the shortcut.
type CyclePhase = 'idle' | 'pressed' | 'open' | 'typing' | 'results'

// Per-character typing interval. Kept tight and constant so the cursor advances
// at an even cadence instead of feeling staggered.
const TYPE_INTERVAL_MS = 90
// Pause on the final, fully-populated state before the cycle resets, so the
// user has time to actually read the matched worktrees + create option.
const HOLD_AFTER_RESULTS_MS = 3200

export function CmdJPaletteFeatureTipVisual(): JSX.Element {
  const reducedMotion = usePrefersReducedMotion()
  // Why: render the live binding so the cue stays correct after a rebind and on
  // platforms where Cmd+J is not the default (Linux/Windows use Ctrl+Shift+J).
  const shortcutKeys = useShortcutKeys('worktree.palette')

  const [phase, setPhase] = useState<CyclePhase>('idle')
  const [typedLength, setTypedLength] = useState(0)

  // Why: for reduced-motion users, jump straight to the fully-populated end
  // state so they see what the feature does without any animation.
  const showPaletteOpen = reducedMotion || phase !== 'idle'
  const isPressed = !reducedMotion && phase === 'pressed'
  const effectiveTypedLength = reducedMotion ? TYPED_QUERY.length : typedLength
  const showResults = reducedMotion || phase === 'results'

  const currentQuery = TYPED_QUERY.slice(0, effectiveTypedLength)

  useEffect(() => {
    if (reducedMotion) {
      return
    }

    let cancelled = false
    const timeouts: number[] = []
    const intervals: number[] = []
    const later = (fn: () => void, ms: number): void => {
      timeouts.push(window.setTimeout(() => !cancelled && fn(), ms))
    }

    const runOnce = (): void => {
      // Reset to the start of the sequence.
      setPhase('idle')
      setTypedLength(0)

      // Beat 1: user presses the shortcut. The key chips pulse once.
      later(() => setPhase('pressed'), 450)
      // Beat 2: palette opens in response to the keypress (cause → effect).
      later(() => setPhase('open'), 850)
      // Beat 3: user starts typing the worktree name.
      later(() => {
        setPhase('typing')
        // Drive typing from a single interval so the cadence is uniform, not
        // drift-prone like a stack of setTimeouts.
        let i = 0
        const id = window.setInterval(() => {
          if (cancelled) {
            window.clearInterval(id)
            return
          }
          i += 1
          setTypedLength(i)
          if (i >= TYPED_QUERY.length) {
            window.clearInterval(id)
          }
        }, TYPE_INTERVAL_MS)
        intervals.push(id)
      }, 1300)

      // Beat 4: once typing finishes, the filtered results appear together —
      // matching how the real palette renders incremental search.
      const typingEnd = 1300 + TYPE_INTERVAL_MS * TYPED_QUERY.length
      later(() => setPhase('results'), typingEnd + 220)
      // Beat 5: hold on the final state long enough to read, then loop.
      later(runOnce, typingEnd + 220 + HOLD_AFTER_RESULTS_MS)
    }

    runOnce()
    return () => {
      cancelled = true
      timeouts.forEach((id) => window.clearTimeout(id))
      intervals.forEach((id) => window.clearInterval(id))
    }
  }, [reducedMotion])

  return (
    <div
      className="relative flex min-h-[23rem] flex-col items-center justify-center overflow-hidden bg-muted/60 px-6 py-7"
      aria-hidden="true"
    >
      {shortcutKeys.length > 0 ? (
        <div className="inline-flex items-center gap-1.5">
          {shortcutKeys.map((key, index) => (
            <span
              key={`${key}-${index}`}
              className={`inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-border/80 px-2 text-xs font-semibold text-muted-foreground shadow-xs transition-[transform,background-color] duration-150 ease-out ${
                isPressed
                  ? 'translate-y-[1.5px] bg-foreground/[0.18]'
                  : 'translate-y-0 bg-foreground/[0.08]'
              }`}
              style={isPressed ? { transitionDelay: `${index * 40}ms` } : undefined}
            >
              {key}
            </span>
          ))}
        </div>
      ) : null}

      <div
        className={`mt-3 w-full max-w-[21rem] overflow-hidden rounded-xl border border-border bg-card text-left shadow-lg transition-[opacity,transform] duration-300 ease-out ${
          showPaletteOpen ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'
        }`}
      >
        {/* Animated input area showing the user typing a worktree name. */}
        <div className="flex items-center gap-2 border-b border-border bg-muted/20 px-3 py-2.5">
          <Search className="size-4 shrink-0 text-muted-foreground/70" />
          <div className="min-w-0 flex-1 truncate text-[13px] text-foreground/90">
            {currentQuery ? (
              currentQuery
            ) : (
              <span className="text-muted-foreground/60">Search workspaces, settings, tabs…</span>
            )}
            {!reducedMotion && (
              <span className="ml-px inline-block h-[14px] w-px -translate-y-px align-middle bg-foreground/75 animate-cmd-j-tip-caret" />
            )}
          </div>
        </div>

        {/* Results area: the two matching worktrees + create-new option appear
            together once typing completes, like the real palette filtering. */}
        <div className="flex min-h-[7.25rem] flex-col gap-0.5 p-1.5">
          {showResults && (
            <>
              {WORKTREE_RESULTS.map((result) => (
                <div
                  key={result.key}
                  className="flex items-center gap-2.5 rounded-lg border border-transparent bg-accent/50 px-2.5 py-1.5 animate-cmd-j-tip-result-in"
                >
                  <span className="flex w-4 shrink-0 items-center justify-center">
                    {result.status === 'done' ? (
                      <span className="size-2.5 rounded-full bg-green-500" aria-hidden="true" />
                    ) : (
                      <Loader2
                        className="size-3 animate-spin text-foreground/60"
                        aria-hidden="true"
                      />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[12.5px] font-semibold tracking-[-0.01em] text-foreground">
                        {result.name}
                      </span>
                      {result.chip && (
                        <span className="shrink-0 rounded-[6px] border border-border/60 bg-background/45 px-1.5 py-px text-[9px] font-medium leading-normal text-muted-foreground/88">
                          {result.chip}
                        </span>
                      )}
                    </div>
                    <span className="text-[10px] text-muted-foreground/70">main</span>
                  </div>
                </div>
              ))}
              <div className="mt-0.5 flex items-center gap-2.5 rounded-lg border border-dashed border-border/60 bg-muted/10 px-2.5 py-1.5 animate-cmd-j-tip-result-in">
                <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-dashed border-border/60 bg-muted/25 text-muted-foreground/70">
                  <Plus size={13} aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[12.5px] font-semibold tracking-[-0.01em] text-foreground">
                    {`Create workspace "${currentQuery || TYPED_QUERY}"`}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
