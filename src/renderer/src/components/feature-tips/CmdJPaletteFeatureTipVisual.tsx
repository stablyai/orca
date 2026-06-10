import { Fragment, useEffect, useState, type JSX } from 'react'
import { Plus, Search } from 'lucide-react'
import { usePrefersReducedMotion } from '@/components/feature-wall/feature-wall-modal-helpers'
import { formatShortcutKeys, useShortcutKeys } from '@/hooks/useShortcutLabel'
import { translate } from '@/i18n/i18n'

const TYPED_QUERY = 'auth'
// Why: the real palette lists recent worktrees on open; typing only narrows the
// list. Mix done + running states so the tip reads like a live worktree switcher.
const DEMO_WORKTREES: readonly {
  key: string
  name: string
  branch: string
  status: 'done' | 'running'
}[] = [
  { key: '1', name: 'payments-api', branch: 'feat/payments-api', status: 'done' },
  { key: '2', name: 'auth-redirect', branch: 'fix/auth-redirect', status: 'done' },
  { key: '3', name: 'oauth-callback', branch: 'fix/oauth-callback', status: 'running' },
  { key: '4', name: 'docs-site', branch: 'main', status: 'done' }
]

function filterDemoWorktrees(query: string): typeof DEMO_WORKTREES {
  const normalized = query.trim().toLowerCase()
  if (!normalized) {
    return DEMO_WORKTREES
  }
  return DEMO_WORKTREES.filter(
    (worktree) =>
      worktree.name.toLowerCase().includes(normalized) ||
      worktree.branch.toLowerCase().includes(normalized)
  )
}

// Why: cycle phases are sequenced so the keypress visibly precedes the palette
// opening (cause → effect), matching what the user will see when they actually
// press the shortcut.
type CyclePhase = 'idle' | 'pressed' | 'open' | 'typing' | 'closing'

type ClosingFrame = {
  query: string
  worktrees: ReturnType<typeof filterDemoWorktrees>
  showCreate: boolean
}

const KEYPRESS_AT_MS = 450
const PALETTE_OPEN_AT_MS = 850
// Why: linger on the empty-query worktree list so users notice the palette
// already shows recent worktrees before filtering kicks in.
const HOLD_BEFORE_TYPING_MS = 700
// Per-character typing interval. Kept tight and constant so the cursor advances
// at an even cadence instead of feeling staggered.
const TYPE_INTERVAL_MS = 120
// Pause on the final, filtered state before the cycle resets, so the
// user has time to actually read the matched worktrees + create option.
const HOLD_AFTER_RESULTS_MS = 3200
// Matches the palette container's `duration-300` fade plus a small buffer so we
// never swap list content while the closing fade is still running.
const PALETTE_FADE_OUT_MS = 350

export function CmdJPaletteFeatureTipVisual(): JSX.Element {
  const reducedMotion = usePrefersReducedMotion()
  // Why: render the live binding so the cue stays correct after a rebind and on
  // platforms where Cmd+J is not the default (Linux/Windows use Ctrl+Shift+J).
  const shortcutKeys = useShortcutKeys('worktree.palette')
  // Why: the press animation staggers per-key chips (⌘ then J); fall back to the
  // platform default when the user disables the binding.
  const displayShortcutKeys =
    shortcutKeys.length > 0 ? shortcutKeys : formatShortcutKeys('worktree.palette')

  const [phase, setPhase] = useState<CyclePhase>('idle')
  const [typedLength, setTypedLength] = useState(0)
  const [closingFrame, setClosingFrame] = useState<ClosingFrame | null>(null)

  // Why: for reduced-motion users, jump straight to the fully-populated end
  // state so they see what the feature does without any animation.
  const isPressed = !reducedMotion && phase === 'pressed'
  const effectiveTypedLength = reducedMotion ? TYPED_QUERY.length : typedLength
  const currentQuery = TYPED_QUERY.slice(0, effectiveTypedLength)
  const visibleWorktrees = filterDemoWorktrees(currentQuery)
  const showCreateAction = currentQuery.trim().length > 0
  // Why: snapshot the final filtered frame during `closing` so loop reset never
  // re-renders the empty-query worktree list while the palette is still visible.
  const renderQuery = phase === 'closing' && closingFrame ? closingFrame.query : currentQuery
  const renderWorktrees =
    phase === 'closing' && closingFrame ? closingFrame.worktrees : visibleWorktrees
  const renderShowCreate =
    phase === 'closing' && closingFrame ? closingFrame.showCreate : showCreateAction
  // Why: mirror WorktreeJumpPalette — recent worktrees render as soon as the
  // palette opens; typing only filters them down. Keep the list mounted through
  // `closing` so the final filtered frame fades out with the palette.
  const showWorktreeList =
    reducedMotion || phase === 'open' || phase === 'typing' || phase === 'closing'
  // Why: keep the palette hidden during `pressed` — an empty search shell between
  // cycles read as the pre-search list flashing back before the fade finished.
  const paletteMounted =
    reducedMotion || phase === 'open' || phase === 'typing' || phase === 'closing'
  const paletteOpaque = reducedMotion || (paletteMounted && phase !== 'closing')
  const resultEnterClass =
    showWorktreeList && !reducedMotion && phase === 'open' ? 'animate-cmd-j-tip-result-in' : ''

  useEffect(() => {
    if (reducedMotion) {
      return
    }

    let cancelled = false
    const timeouts: number[] = []
    const later = (fn: () => void, ms: number): void => {
      timeouts.push(window.setTimeout(() => !cancelled && fn(), ms))
    }

    const startTyping = (startIndex: number): void => {
      let i = startIndex
      const typeNext = (): void => {
        if (cancelled) {
          return
        }
        i += 1
        setTypedLength(i)
        if (i >= TYPED_QUERY.length) {
          later(() => closeAndRestart(), HOLD_AFTER_RESULTS_MS)
          return
        }
        timeouts.push(window.setTimeout(typeNext, TYPE_INTERVAL_MS))
      }
      if (i >= TYPED_QUERY.length) {
        later(() => closeAndRestart(), HOLD_AFTER_RESULTS_MS)
        return
      }
      later(typeNext, TYPE_INTERVAL_MS)
    }

    const scheduleCycle = (): void => {
      later(() => setPhase('pressed'), KEYPRESS_AT_MS)
      later(() => setPhase('open'), PALETTE_OPEN_AT_MS)
      later(() => {
        setPhase('typing')
        startTyping(0)
      }, PALETTE_OPEN_AT_MS + HOLD_BEFORE_TYPING_MS)
    }

    const closeAndRestart = (): void => {
      setClosingFrame({
        query: TYPED_QUERY,
        worktrees: filterDemoWorktrees(TYPED_QUERY),
        showCreate: true
      })
      setPhase('closing')
      later(() => {
        setPhase('idle')
        setClosingFrame(null)
        setTypedLength(0)
        scheduleCycle()
      }, PALETTE_FADE_OUT_MS)
    }

    setPhase('idle')
    setTypedLength(0)
    scheduleCycle()

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
      {displayShortcutKeys.length > 0 ? (
        <div className="inline-flex items-center gap-1.5">
          {displayShortcutKeys.map((key, index) => (
            <Fragment key={`${key}-${index}`}>
              {index > 0 ? (
                <span className="text-xs text-muted-foreground" aria-hidden="true">
                  +
                </span>
              ) : null}
              <span
                className={`inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-border/80 px-2 text-xs font-semibold text-muted-foreground shadow-xs transition-[transform,background-color] duration-150 ease-out ${
                  isPressed
                    ? 'translate-y-[1.5px] bg-foreground/[0.18]'
                    : 'translate-y-0 bg-foreground/[0.08]'
                }`}
                style={isPressed ? { transitionDelay: `${index * 40}ms` } : undefined}
              >
                {key}
              </span>
            </Fragment>
          ))}
        </div>
      ) : null}

      <div
        className={`relative mt-3 h-[12.75rem] w-full max-w-[21rem] overflow-hidden rounded-xl border border-border bg-card text-left shadow-lg transition-opacity duration-300 ease-out ${
          !paletteMounted
            ? 'pointer-events-none invisible opacity-0'
            : paletteOpaque
              ? 'opacity-100'
              : 'opacity-0'
        }`}
      >
        {/* Why: search and results are absolutely positioned so row content
            changes during the demo never reflow the input bar mid-animation. */}
        <div className="absolute inset-x-0 top-0 flex h-11 items-center gap-2 border-b border-border bg-muted/20 px-3">
          <Search className="size-4 shrink-0 text-muted-foreground/70" />
          <div className="h-5 min-w-0 flex-1 overflow-hidden text-[13px] leading-5 text-foreground/90">
            <span className="block truncate">
              {renderQuery}
              {!reducedMotion && (phase === 'open' || phase === 'typing') ? (
                <span className="ml-px inline-block h-[14px] w-px -translate-y-px align-middle bg-foreground/75 animate-cmd-j-tip-caret" />
              ) : null}
            </span>
          </div>
        </div>

        {showWorktreeList ? (
          <div className="absolute inset-x-0 top-11 bottom-0 flex flex-col gap-0.5 overflow-hidden p-1.5">
            {renderWorktrees.map((result) => (
              <div
                key={result.key}
                className={`flex shrink-0 items-center gap-2.5 rounded-lg border border-transparent px-2.5 py-1.5 ${resultEnterClass}`}
              >
                <span className="flex w-4 shrink-0 items-center justify-center">
                  {result.status === 'done' ? (
                    <span className="size-2.5 rounded-full bg-emerald-500" aria-hidden="true" />
                  ) : (
                    // Why: yellow border spinner mirrors StatusIndicator's
                    // 'working' affordance, so users connect the icon to the
                    // same running-workspace state they see in the sidebar.
                    <span
                      className={`block size-2.5 rounded-full border-[1.5px] border-yellow-500 ${
                        reducedMotion ? 'border-t-yellow-500' : 'animate-spin border-t-transparent'
                      }`}
                    />
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
            {renderShowCreate ? (
              <div
                className={`mt-0.5 flex shrink-0 items-center gap-2.5 rounded-lg border border-dashed border-border/60 bg-muted/10 px-2.5 py-1.5 ${resultEnterClass}`}
              >
                <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-dashed border-border/60 bg-muted/25 text-muted-foreground/70">
                  <Plus size={13} aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1 truncate text-[12.5px] font-semibold tracking-[-0.01em] text-foreground">
                  {translate(
                    'auto.components.feature.tips.CmdJPaletteFeatureTipVisual.ab94e16d44',
                    'Create worktree "{{value0}}"',
                    { value0: renderQuery.trim() }
                  )}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
