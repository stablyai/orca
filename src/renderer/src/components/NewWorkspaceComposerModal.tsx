import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import NewWorkspaceComposerCard from '@/components/NewWorkspaceComposerCard'
import AgentSettingsDialog from '@/components/agent/AgentSettingsDialog'
import CreateFromTab from '@/components/new-workspace/CreateFromTab'
import { useComposerState } from '@/hooks/useComposerState'
import { AGENT_CATALOG } from '@/lib/agent-catalog'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import { shouldSuppressEnterSubmit } from '@/lib/new-workspace-enter-guard'
import { cn } from '@/lib/utils'
import type { TuiAgent } from '../../../shared/types'

type ComposerModalData = {
  prefilledName?: string
  initialRepoId?: string
  linkedWorkItem?: LinkedWorkItemSummary | null
  initialBaseBranch?: string
  initialTab?: 'quick' | 'create-from'
}

const isMac = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')
const tabShortcut = {
  quick: isMac ? '⌘N' : 'Ctrl+N',
  'create-from': isMac ? '⌘⇧N' : 'Ctrl+Shift+N'
} as const

function ShortcutHint({ children }: { children: React.ReactNode }): React.JSX.Element {
  // Why: a flat muted string reads as "secondary hint" rather than the
  // bordered kbd chip, which drew too much attention for a label most users
  // will learn once and forget. Stays inside the tab trigger so the hit
  // target covers it too.
  return (
    <span className="text-[10px] font-normal tracking-wide text-muted-foreground/70">
      {children}
    </span>
  )
}

export default function NewWorkspaceComposerModal(): React.JSX.Element | null {
  const visible = useAppStore((s) => s.activeModal === 'new-workspace-composer')
  const modalData = useAppStore((s) => s.modalData as ComposerModalData | undefined)
  const closeModal = useAppStore((s) => s.closeModal)

  // Why: Dialog open-state transitions must be driven by the store, not a
  // mirror useState, so palette/open-modal calls feel instantaneous and the
  // modal doesn't linger with stale data after close.
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        closeModal()
      }
    },
    [closeModal]
  )

  if (!visible) {
    return null
  }

  return (
    <ComposerModalBody
      modalData={modalData ?? {}}
      onClose={closeModal}
      onOpenChange={handleOpenChange}
    />
  )
}

function ComposerModalBody({
  modalData,
  onClose,
  onOpenChange
}: {
  modalData: ComposerModalData
  onClose: () => void
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const activeTab = useAppStore((s) => s.newWorkspaceComposerTab)
  const setActiveTab = useAppStore((s) => s.setNewWorkspaceComposerTab)

  // Why: when the user starts something on Create-from that needs to fall
  // back to Quick (setup policy = 'ask', PR head resolution failed, ...) we
  // feed the prefill through this local override and remount the Quick
  // composer via a bumped key so its initial state absorbs the new data.
  // Without the key bump the useComposerState hook would keep its first
  // snapshot and the Quick tab would appear empty after fallback.
  const [prefillOverride, setPrefillOverride] = useState<ComposerModalData | null>(null)
  const [quickKey, setQuickKey] = useState(0)

  const effectiveQuickData = prefillOverride ?? modalData

  const handleFallbackToQuick = useCallback(
    (data: {
      initialRepoId?: string
      linkedWorkItem?: LinkedWorkItemSummary | null
      prefilledName?: string
      initialBaseBranch?: string
    }) => {
      setPrefillOverride({ ...data })
      setQuickKey((k) => k + 1)
      setActiveTab('quick')
    },
    [setActiveTab]
  )

  const handleCreateFromLaunched = useCallback(() => {
    onClose()
  }, [onClose])

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        // Why: pin a single width across both tabs. Create-from needs the
        // extra horizontal room for PR titles + branch names; Quick tolerates
        // it fine. Animating between widths was jarring and made the modal
        // feel unstable every time the user toggled tabs.
        className="flex flex-col sm:max-w-lg"
        onOpenAutoFocus={(event) => {
          // Why: Radix's FocusScope fires this once the dialog has mounted and
          // the DOM is ready. preventDefault stops it from focusing the first
          // tabbable in the Quick tab (the repo combobox trigger) when the
          // Create-from tab is active — that tab wants the search input to
          // own initial focus. The QuickTabBody handles its own focus below
          // when the Quick tab is active.
          if (activeTab === 'create-from') {
            return
          }
          event.preventDefault()
          const content = event.currentTarget as HTMLElement
          const trigger = content.querySelector<HTMLElement>(
            '[data-repo-combobox-root="true"][role="combobox"]'
          )
          trigger?.focus({ preventScroll: true })
        }}
      >
        <Tabs
          value={activeTab}
          onValueChange={(next) => setActiveTab(next as 'quick' | 'create-from')}
          // Why: both panels are force-mounted so switching tabs preserves
          // their local state (typed query on Create-from, repo pick /
          // workspace name on Quick) instead of remounting each time.
          // Height is driven by the active panel's intrinsic size — the
          // DialogContent handles overflow if the viewport is too short.
          className="flex flex-col gap-0"
        >
          {/* Why: use the shared underline variant so both levels of tabs
              read as "tabs" — the default pill variant fought the sub-tabs
              inside Create-from for visual weight. The bottom border on the
              list gives it clear separation from the content below. */}
          {/* Why: DialogContent has p-6 (24px top) and the close button sits
              absolutely at top-4 (16px), so its 16px icon centers around 24px
              from the top. Pull the h-8 tab list up with -mt-4 so its center
              (8 + 16 = 24px) lines up with the X on the same row. Reserve
              right padding so the last trigger doesn't slide under the X. */}
          <TabsList
            variant="line"
            className="-mt-4 h-8 w-full justify-start gap-6 border-b border-border/60 px-0 pr-8"
          >
            <TabsTrigger value="quick" className="flex-none gap-2 px-0 text-xs font-medium">
              Form
              <ShortcutHint>{tabShortcut.quick}</ShortcutHint>
            </TabsTrigger>
            <TabsTrigger value="create-from" className="flex-none gap-2 px-0 text-xs font-medium">
              Create from…
              <ShortcutHint>{tabShortcut['create-from']}</ShortcutHint>
            </TabsTrigger>
          </TabsList>

          <DialogHeader className="gap-1 pt-4">
            <DialogTitle className="text-base font-semibold">Create Workspace</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              {activeTab === 'quick'
                ? 'Pick a repository and agent to spin up a new workspace.'
                : 'Start from an existing PR, issue, branch, or Linear ticket.'}
            </DialogDescription>
          </DialogHeader>

          <AnimatedTabPanels active={activeTab}>
            {{
              quick: (
                <QuickTabBody
                  key={quickKey}
                  modalData={effectiveQuickData}
                  onClose={onClose}
                  active={activeTab === 'quick'}
                />
              ),
              'create-from': (
                <CreateFromTab
                  onLaunched={handleCreateFromLaunched}
                  onFallbackToQuick={handleFallbackToQuick}
                  active={activeTab === 'create-from'}
                />
              )
            }}
          </AnimatedTabPanels>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

function QuickTabBody({
  modalData,
  onClose,
  active
}: {
  modalData: ComposerModalData
  onClose: () => void
  active: boolean
}): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const { cardProps, composerRef, nameInputRef, submitQuick, createDisabled } = useComposerState({
    initialName: modalData.prefilledName ?? '',
    // Why: the modal is quick-create only now, so prompt-prefill state is
    // intentionally ignored even if older callers still send it.
    initialPrompt: '',
    initialLinkedWorkItem: modalData.linkedWorkItem ?? null,
    initialRepoId: modalData.initialRepoId,
    ...(modalData.initialBaseBranch ? { initialBaseBranch: modalData.initialBaseBranch } : {}),
    persistDraft: false,
    onCreated: onClose
  })
  // Why: the composer's built-in `onOpenAgentSettings` handler navigates to
  // the settings page and closes the modal. For the quick-create flow we want
  // a less disruptive affordance — a nested dialog layered over the composer
  // so the user can tweak agents without losing their in-progress workspace
  // name/repo selection.
  const [agentSettingsOpen, setAgentSettingsOpen] = useState(false)
  // Why: once the user picks an agent, their choice wins and must not be
  // overwritten when the derived "preferred" value changes (e.g. detection
  // finishes and adds more installed agents to the set). Track that with an
  // override rather than an effect that mirrors a prop into state — deriving
  // during render keeps the selection in sync with the detected set without
  // triggering an extra commit.
  const [quickAgentOverride, setQuickAgentOverride] = useState<TuiAgent | null | undefined>(
    undefined
  )
  const preferredQuickAgent = useMemo<TuiAgent | null>(() => {
    const pref = settings?.defaultTuiAgent
    if (pref === 'blank') {
      // Why: 'blank' is the explicit "no agent" preference — the quick agent
      // model already uses null to mean "blank terminal", so translate here.
      return null
    }
    if (pref) {
      return pref
    }
    const detected = cardProps.detectedAgentIds
    return AGENT_CATALOG.find((agent) => detected === null || detected.has(agent.id))?.id ?? null
  }, [cardProps.detectedAgentIds, settings?.defaultTuiAgent])
  const quickAgent = quickAgentOverride === undefined ? preferredQuickAgent : quickAgentOverride

  const handleQuickAgentChange = useCallback((agent: TuiAgent | null) => {
    setQuickAgentOverride(agent)
  }, [])

  const handleCreate = useCallback(async (): Promise<void> => {
    await submitQuick(quickAgent)
  }, [quickAgent, submitQuick])

  // Cmd/Ctrl+Enter submits, Esc first blurs the focused input (like the full page).
  useEffect(() => {
    if (!active) {
      return
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter' && event.key !== 'Escape') {
        return
      }
      const target = event.target
      if (!(target instanceof HTMLElement)) {
        return
      }

      if (event.key === 'Escape') {
        if (
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target instanceof HTMLSelectElement ||
          target.isContentEditable
        ) {
          event.preventDefault()
          target.blur()
          return
        }
        event.preventDefault()
        onClose()
        return
      }

      // Why: require the platform modifier (Cmd on macOS, Ctrl elsewhere) so
      // plain Enter inside fields (notes, repo search) doesn't accidentally
      // submit — users can type or confirm selections without triggering
      // workspace creation.
      const hasModifier = event.metaKey || event.ctrlKey
      if (!hasModifier) {
        return
      }
      if (!composerRef.current?.contains(target)) {
        return
      }
      if (createDisabled) {
        return
      }
      if (shouldSuppressEnterSubmit(event, false)) {
        return
      }
      event.preventDefault()
      void handleCreate()
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [active, composerRef, createDisabled, handleCreate, onClose])

  // Why: when the Quick tab becomes active (initial mount, or switched to
  // from Create-from), focus the repo combobox trigger so the confirmed
  // selection sits ready and the keyboard flow starts at the top of the
  // form — matching Dialog's onOpenAutoFocus behavior in the pre-tabs modal.
  useEffect(() => {
    if (!active) {
      return
    }
    const root = composerRef.current
    if (!root) {
      return
    }
    const trigger = root.querySelector<HTMLElement>(
      '[data-repo-combobox-root="true"][role="combobox"]'
    )
    trigger?.focus({ preventScroll: true })
  }, [active, composerRef])

  return (
    <>
      <NewWorkspaceComposerCard
        composerRef={composerRef}
        nameInputRef={nameInputRef}
        quickAgent={quickAgent}
        onQuickAgentChange={handleQuickAgentChange}
        {...cardProps}
        onOpenAgentSettings={() => setAgentSettingsOpen(true)}
        onCreate={() => void handleCreate()}
      />
      <AgentSettingsDialog open={agentSettingsOpen} onOpenChange={setAgentSettingsOpen} />
    </>
  )
}

type TabKey = 'quick' | 'create-from'

/**
 * Keeps both tab panels mounted so their local state (typed query on
 * Create-from, repo pick / workspace name on Quick) survives a tab swap.
 * Only the active panel is in normal flow; the inactive panel is
 * absolutely positioned + `visibility: hidden` + `pointer-events-none`
 * so it
 *   (a) doesn't contribute to DialogContent's scrollHeight (otherwise the
 *       host dialog grows a scrollbar whenever the inactive panel is
 *       taller than the active one), and
 *   (b) keeps its React subtree mounted (no remount, so input focus,
 *       typed query, and selection survive).
 *
 * The wrapper's height is JS-driven: a ResizeObserver on the active
 * panel's inner node keeps wrapper height in sync with content so the
 * wrapper never clips. On tab change we capture the pre-swap wrapper
 * height and transition to the new active panel's measured height — a
 * FLIP-style animation so the modal resizes smoothly rather than
 * snapping.
 */
function AnimatedTabPanels({
  active,
  children
}: {
  active: TabKey
  children: Record<TabKey, React.ReactNode>
}): React.JSX.Element {
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const quickRef = useRef<HTMLDivElement | null>(null)
  const createFromRef = useRef<HTMLDivElement | null>(null)
  const previousActiveRef = useRef<TabKey>(active)
  const [wrapperHeight, setWrapperHeight] = useState<number | null>(null)
  const [isAnimating, setIsAnimating] = useState(false)

  // Why: track the active panel's intrinsic height via ResizeObserver so
  // the wrapper follows content (Advanced drawer open/close, async search
  // results landing). When active changes, the FLIP effect below runs
  // first (capturing the outgoing height), then this observer swings the
  // wrapper height toward the new active panel's height via the CSS
  // transition on `height`.
  //
  // Why offsetHeight and not getBoundingClientRect().height: Radix's
  // dialog open animation (`data-[state=open]:zoom-in-95`) scales the
  // dialog from 0.95 → 1.0 over 200ms. getBoundingClientRect reports the
  // *visual* (transformed) height, so the very first measurement lands at
  // ~95 % of the real layout size and pins that into the inline height.
  // The ResizeObserver never refires because actual layout size didn't
  // change — only the transform did — so the wrapper stays permanently
  // ~16 px short and clips the Create Workspace button at the bottom.
  // offsetHeight returns the un-transformed layout box, which is what the
  // wrapper should match.
  useLayoutEffect(() => {
    const target = active === 'quick' ? quickRef.current : createFromRef.current
    if (!target) {
      return
    }
    const update = (): void => {
      const next = target.offsetHeight
      if (next > 0) {
        setWrapperHeight(next)
      }
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(target)
    return () => observer.disconnect()
  }, [active])

  // Why: on tab swap, override the observer-driven height for one frame
  // so the transition starts from the outgoing panel's size. Without this
  // the wrapper would snap to the new panel's height before the ResizeObserver
  // could read it.
  useLayoutEffect(() => {
    const prev = previousActiveRef.current
    previousActiveRef.current = active
    if (prev === active) {
      return
    }
    const wrapper = wrapperRef.current
    if (!wrapper) {
      return
    }
    // Why: offsetHeight, not getBoundingClientRect — see comment on the
    // observer effect above. Same transform-scale trap applies to this
    // FLIP capture if a tab swap happens while any ancestor transform is
    // still animating.
    const from = wrapper.offsetHeight
    if (from > 0) {
      setWrapperHeight(from)
      setIsAnimating(true)
    }
  }, [active])

  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper || !isAnimating) {
      return
    }
    const onEnd = (event: TransitionEvent): void => {
      if (event.propertyName !== 'height') {
        return
      }
      setIsAnimating(false)
    }
    wrapper.addEventListener('transitionend', onEnd)
    return () => wrapper.removeEventListener('transitionend', onEnd)
  }, [isAnimating])

  return (
    <div
      ref={wrapperRef}
      // Why: `overflow: clip` isolates the absolutely-positioned inactive
      // panel so the wrapper's measured height drives the dialog (not the
      // stacked panel heights). We avoid plain `overflow: hidden` because
      // that also clips the 3px focus rings painted by nested inputs
      // (RepoCombobox, workspace name field, etc.) — the inner panels are
      // `inset-x-0` so their triggers sit flush against the wrapper edges,
      // leaving no room for a ring to paint. `overflow-clip-margin` gives
      // the ring breathing room on every side without re-introducing scroll
      // containers or letting the inactive panel leak layout.
      className="relative overflow-clip transition-[height] duration-200 ease-out"
      style={{
        ...(wrapperHeight !== null ? { height: wrapperHeight } : null),
        overflowClipMargin: '8px'
      }}
    >
      <div
        ref={quickRef}
        className={cn(
          'pt-4',
          active === 'quick'
            ? 'pointer-events-auto'
            : 'pointer-events-none invisible absolute inset-x-0 top-0'
        )}
        aria-hidden={active !== 'quick'}
      >
        {children.quick}
      </div>
      <div
        ref={createFromRef}
        className={cn(
          'pt-3',
          active === 'create-from'
            ? 'pointer-events-auto'
            : 'pointer-events-none invisible absolute inset-x-0 top-0'
        )}
        aria-hidden={active !== 'create-from'}
      >
        {children['create-from']}
      </div>
    </div>
  )
}
