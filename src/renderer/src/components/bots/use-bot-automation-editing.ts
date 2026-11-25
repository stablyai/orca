import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import type { Automation } from '../../../../shared/automations/automation-definition'
import type { AutomationDraft } from '../automations/authoring/AutomationEditorDialog'
import type {
  BotAutomationSection,
  BotAutomationEditBase
} from '../automations/authoring/automation-bot-section-save'
import {
  discardBotAutomationDraft,
  readRetainedBotAutomationDraft,
  retainBotAutomationDraft
} from './bot-automation-drafts'
export type Editing = {
  section: BotAutomationSection
  draft: AutomationDraft
  savedAutomation: BotAutomationEditBase
  base: unknown
  restored: boolean
  saving: boolean
  error: string | null
  conflict: Automation | null
}

/** The open section editor, kept across a remount; one section at a time per automation. */
export function useBotAutomationEditing(screenKey: string): {
  editing: Editing | null
  setEditing: React.Dispatch<React.SetStateAction<Editing | null>>
  /** Back, Escape and the crumb discard it; nothing else does. */
  discard: () => void
} {
  const t = useTranslate()
  const [editing, setState] = useState<Editing | null>(() => {
    const kept = readRetainedBotAutomationDraft(screenKey)
    return kept ? { ...kept, restored: true, saving: false, error: null, conflict: null } : null
  })
  const latest = useRef(editing)
  // A save that answers after this editor unmounted must not keep or drop the draft a newer one holds.
  const alive = useRef(true)
  const setEditing: React.Dispatch<React.SetStateAction<Editing | null>> = (change) => {
    if (!alive.current) {
      return
    }
    const previous = latest.current
    let next = typeof change === 'function' ? change(previous) : change
    if (next && !retainBotAutomationDraft(screenKey, next)) {
      if (!previous) {
        toast.error(
          t(
            'bots.automationPanel.editCapacity',
            'Save or discard another automation edit before opening this editor.'
          )
        )
      }
      next = previous
        ? {
            ...previous,
            saving: false,
            error: t(
              'bots.automationPanel.editTooLarge',
              'This change is too large to keep. Save or discard another automation edit first.'
            )
          }
        : null
    }
    if (!next) {
      discardBotAutomationDraft(screenKey)
    }
    latest.current = next
    setState(next)
  }
  useLayoutEffect(() => {
    latest.current = editing
  })
  const discarded = useRef(false)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      const open = latest.current
      if (open && !discarded.current) {
        retainBotAutomationDraft(screenKey, {
          section: open.section,
          draft: open.draft,
          savedAutomation: open.savedAutomation,
          base: open.base
        })
      }
    }
  }, [screenKey])
  return {
    editing,
    setEditing,
    discard: () => {
      discarded.current = true
      discardBotAutomationDraft(screenKey)
      setEditing(null)
    }
  }
}
