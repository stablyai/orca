import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import NewWorkspaceComposerCard from '@/components/NewWorkspaceComposerCard'
import AgentSettingsDialog from '@/components/agent/AgentSettingsDialog'
import { useComposerState } from '@/hooks/useComposerState'
import { AGENT_CATALOG } from '@/lib/agent-catalog'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import { shouldSuppressEnterSubmit } from '@/lib/new-workspace-enter-guard'
import type { TuiAgent } from '../../../shared/types'

type ComposerModalData = {
  prefilledName?: string
  initialRepoId?: string
  linkedWorkItem?: LinkedWorkItemSummary | null
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
  const settings = useAppStore((s) => s.settings)
  const { cardProps, composerRef, nameInputRef, submitQuick, createDisabled } = useComposerState({
    initialName: modalData.prefilledName ?? '',
    // Why: the modal is quick-create only now, so prompt-prefill state is
    // intentionally ignored even if older callers still send it.
    initialPrompt: '',
    initialLinkedWorkItem: modalData.linkedWorkItem ?? null,
    initialRepoId: modalData.initialRepoId,
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
  }, [composerRef, createDisabled, handleCreate, onClose])

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-md"
        onOpenAutoFocus={(event) => {
          // Why: Radix's FocusScope fires this once the dialog has mounted and
          // the DOM is ready. preventDefault stops it from focusing the first
          // tabbable (which would otherwise steal focus to whatever ships
          // first in markup); we then focus the repo combobox trigger so the
          // guessed value sits as a confirmed selection without opening its
          // popover — matching the "default = selection, typing = search"
          // combobox pattern. Doing it here (instead of a child rAF) avoids
          // Strict-Mode effect double-invocation dropping the focus call.
          event.preventDefault()
          const content = event.currentTarget as HTMLElement
          const trigger = content.querySelector<HTMLElement>(
            '[data-repo-combobox-root="true"][role="combobox"]'
          )
          trigger?.focus({ preventScroll: true })
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-sm">Create Workspace</DialogTitle>
          <DialogDescription className="text-xs">
            Pick a repository and agent to spin up a new workspace.
          </DialogDescription>
        </DialogHeader>
        <NewWorkspaceComposerCard
          composerRef={composerRef}
          nameInputRef={nameInputRef}
          quickAgent={quickAgent}
          onQuickAgentChange={handleQuickAgentChange}
          {...cardProps}
          onOpenAgentSettings={() => setAgentSettingsOpen(true)}
          onCreate={() => void handleCreate()}
        />
      </DialogContent>
      <AgentSettingsDialog open={agentSettingsOpen} onOpenChange={setAgentSettingsOpen} />
    </Dialog>
  )
}
