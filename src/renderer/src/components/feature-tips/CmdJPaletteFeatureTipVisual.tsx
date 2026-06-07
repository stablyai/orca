import { useEffect, useState, type JSX } from 'react'
import { Plus, Search } from 'lucide-react'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion'
import { useShortcutKeys } from '@/hooks/useShortcutLabel'

const TYPED_QUERY = 'auth'
// Why: one finished + one still running mirrors what a user actually sees in
// the palette (mixed agent states), making the tip's value visible at a glance.
const WORKTREE_RESULTS: readonly {
  key: string
  name: string
  branch: string
  status: 'done' | 'running'
}[] = [
  { key: '1', name: 'auth-redirect', branch: 'fix/auth-redirect', status: 'done' },
  { key: '2', name: 'oauth-callback', branch: 'fix/oauth-callback', status: 'running' }
]

// Why: cycle phases are sequenced so the keypress visibly precedes the palette
// opening (cause → effect), matching what the user will see when they actually
// press the shortcut.
type CyclePhase = 'idle' | 'pressed' | 'open' | 'typing' | 'results'

// Per-character typing interval. Kept tight and constant so the cursor advances
// at an even cadence instead of feeling staggered.
const TYPE_INTERVAL_MS = 120
// Short beat after the query is complete before results appear — fast enough to
// feel responsive, slow enough to read the finished search term.
const RESULT_REVEAL_DELAY_MS = 150
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
        let i = 0
        const typeNext = (): void => {
          if (cancelled) {
            return
          }
          i += 1
          setTypedLength(i)
          if (i >= TYPED_QUERY.length) {
            later(() => {
              setPhase('results')
              later(runOnce, HOLD_AFTER_RESULTS_MS)
            }, RESULT_REVEAL_DELAY_MS)
            return
          }
          timeouts.push(window.setTimeout(typeNext, TYPE_INTERVAL_MS))
        }
        later(typeNext, TYPE_INTERVAL_MS)
      }, 1300)
    }

    runOnce()
    return () => {
      cancelled = true
      timeouts.forEach((id) => window.clearTimeout(id))
    }
  }, [reducedMotion])

  return (
    <div
      className="relative flex h-full min-h-[23rem] flex-col items-center justify-center overflow-hidden px-6 py-7"
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
        className={`relative mt-3 h-[12.75rem] w-full max-w-[21rem] overflow-hidden rounded-xl border border-border bg-card text-left shadow-lg transition-opacity duration-300 ease-out ${
          showPaletteOpen ? 'opacity-100' : 'opacity-0'
        }`}
      >
        {/* Why: search and results are absolutely positioned so row content
            changes during the demo never reflow the input bar mid-animation. */}
        <div className="absolute inset-x-0 top-0 flex h-11 items-center gap-2 border-b border-border bg-muted/20 px-3">
          <Search className="size-4 shrink-0 text-muted-foreground/70" />
          <div className="h-5 min-w-0 flex-1 overflow-hidden text-[13px] leading-5 text-foreground/90">
            <span className="block truncate">
              {currentQuery}
              {!reducedMotion && phase !== 'idle' && phase !== 'pressed' ? (
                <span className="ml-px inline-block h-[14px] w-px -translate-y-px align-middle bg-foreground/75 animate-cmd-j-tip-caret" />
              ) : null}
            </span>
          </div>
        </div>

        <div
          className={`absolute inset-x-0 top-11 bottom-0 flex flex-col gap-0.5 overflow-hidden p-1.5 transition-opacity duration-150 ease-out ${
            showResults ? 'opacity-100' : 'opacity-0'
          }`}
          aria-hidden={!showResults}
        >
          {WORKTREE_RESULTS.map((result) => (
            <div
              key={result.key}
              className={`flex shrink-0 items-center gap-2.5 rounded-lg border border-transparent px-2.5 py-1.5 ${
                showResults ? 'animate-cmd-j-tip-result-in' : ''
              }`}
            >
              <span className="flex w-4 shrink-0 items-center justify-center">
                {result.status === 'done' ? (
                  <span className="size-2.5 rounded-full bg-emerald-500" aria-hidden="true" />
                ) : (
                  // Why: yellow border spinner mirrors StatusIndicator's
                  // 'working' affordance, so users connect the icon to the
                  // same running-workspace state they see in the sidebar.
                  <span className="block size-2.5 rounded-full border-[1.5px] border-yellow-500 border-t-transparent animate-spin" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] font-semibold tracking-[-0.01em] text-foreground">
                  {result.name}
                </span>
                <span className="block truncate text-[10px] text-muted-foreground/70">
                  {result.branch}
                </span>
              </div>
            </div>
          ))}
          <div
            className={`mt-0.5 flex shrink-0 items-center gap-2.5 rounded-lg border border-dashed border-border/60 bg-muted/10 px-2.5 py-1.5 ${
              showResults ? 'animate-cmd-j-tip-result-in' : ''
            }`}
          >
            <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-dashed border-border/60 bg-muted/25 text-muted-foreground/70">
              <Plus size={13} aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1 truncate text-[12.5px] font-semibold tracking-[-0.01em] text-foreground">
              {`Create workspace "${TYPED_QUERY}"`}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
