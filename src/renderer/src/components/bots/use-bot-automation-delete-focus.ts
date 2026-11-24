import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { AutomationEnabledOverride } from './bot-automation-row-membership'
import type {
  BotAutomationDeleteAdmission,
  BotAutomationDeleteIntent,
  BotAutomationDeleteOutcome,
  BotAutomationDeletion
} from './use-bot-automation-delete'

export type BotAutomationFocusIntent = BotAutomationDeleteIntent & {
  rowKey: string
  folded: boolean
  saved: AutomationEnabledOverride | null
}

type FollowedDelete = {
  intent: BotAutomationFocusIntent
  mount: HTMLElement
  opId: number
  order: string[]
  awaitingClose: boolean
  restoreRow: boolean
  leftOtherwise: boolean
  outcome: BotAutomationDeleteOutcome | null
}

const ROW_OPEN = '[data-bot-row-open]'

function openableRows(section: HTMLElement | null): Map<string, HTMLElement> {
  const rows = new Map<string, HTMLElement>()
  for (const button of section?.querySelectorAll<HTMLElement>(ROW_OPEN) ?? []) {
    const key = button.closest<HTMLElement>('[data-bot-panel-row]')?.dataset.botPanelRow
    if (key) {
      rows.set(key, button)
    }
  }
  return rows
}

function focus(element: HTMLElement | null | undefined): boolean {
  element?.focus()
  return Boolean(element && element.ownerDocument.activeElement === element)
}

function canMoveFocus(entry: FollowedDelete, button?: HTMLElement): boolean {
  const active = entry.mount.ownerDocument.activeElement
  return (
    !active ||
    active === entry.mount.ownerDocument.body ||
    Boolean(button?.closest('[data-bot-panel-row]')?.contains(active))
  )
}

function ownsFocus(
  entry: FollowedDelete,
  mount: HTMLElement | null,
  view: BotAutomationDeletion
): boolean {
  const pending = view.pending.get(entry.intent.id)
  return (
    mount === entry.mount &&
    view.ownsFocus(entry.intent) &&
    (!pending || pending.opId === entry.opId)
  )
}

export function useBotAutomationDeleteFocus({
  deletion,
  open,
  panelFallback,
  troubleCleared
}: {
  deletion: BotAutomationDeletion
  open: boolean
  panelFallback: RefObject<HTMLDivElement | null>
  troubleCleared: (intent: BotAutomationFocusIntent) => boolean
}) {
  const section = useRef<HTMLElement | null>(null)
  const newButton = useRef<HTMLButtonElement | null>(null)
  const [newShown, setNewShown] = useState(false)
  const revealing = useRef<FollowedDelete | null>(null)
  const followed = useRef(new Map<number, FollowedDelete>())
  const closing = useRef(new Map<number, FollowedDelete>())
  const liveDeletion = useRef(deletion)
  const [revision, wake] = useState(0)

  const follow = (
    intent: BotAutomationFocusIntent,
    admission: BotAutomationDeleteAdmission,
    dialog?: number
  ): void => {
    if (!section.current) {
      return
    }
    const entry: FollowedDelete = {
      intent,
      mount: section.current,
      opId: admission.opId,
      order: [...openableRows(section.current).keys()],
      awaitingClose: dialog !== undefined,
      restoreRow: false,
      leftOtherwise: false,
      outcome: null
    }
    for (const [id, previous] of followed.current) {
      if (previous.intent.rowKey === intent.rowKey) {
        followed.current.delete(id)
      }
    }
    if (revealing.current?.intent.rowKey === intent.rowKey) {
      revealing.current = null
      setNewShown(false)
    }
    followed.current.set(entry.opId, entry)
    if (dialog !== undefined) {
      closing.current.set(dialog, entry)
    }
    void admission.settled.then((outcome) => {
      if (
        followed.current.get(entry.opId) === entry &&
        ownsFocus(entry, section.current, liveDeletion.current)
      ) {
        entry.outcome = outcome
        wake((value) => value + 1)
      }
    })
  }

  const onCloseAutoFocus = (dialog: number, event: Event): void => {
    const entry = closing.current.get(dialog)
    closing.current.delete(dialog)
    if (entry) {
      event.preventDefault()
      if (
        followed.current.get(entry.opId) === entry &&
        ownsFocus(entry, section.current, liveDeletion.current)
      ) {
        entry.awaitingClose = false
        entry.restoreRow = true
        wake((value) => value + 1)
      }
    }
  }

  useLayoutEffect(() => {
    liveDeletion.current = deletion
    if (!revealing.current && followed.current.size === 0) {
      return
    }
    const rows = openableRows(section.current)
    const foldButton = section.current?.querySelector<HTMLElement>('button[aria-expanded]')
    const tryFocus = (entry: FollowedDelete, target?: HTMLElement | null): boolean =>
      ownsFocus(entry, section.current, deletion) &&
      canMoveFocus(entry, rows.get(entry.intent.rowKey)) &&
      focus(target)
    const fallback = (entry: FollowedDelete): void => {
      if (!tryFocus(entry, foldButton)) {
        tryFocus(entry, panelFallback.current)
      }
    }
    const mayHandOff = (entry: FollowedDelete): boolean => {
      const { intent } = entry
      const membership = deletion.membership(intent)
      return (
        ownsFocus(entry, section.current, deletion) &&
        !entry.leftOtherwise &&
        !rows.has(intent.rowKey) &&
        canMoveFocus(entry) &&
        ((entry.outcome === 'hidden' &&
          (deletion.hidden.has(intent.id) || membership === 'absent')) ||
          (entry.outcome === 'omitted' && membership === 'absent') ||
          (entry.outcome === 'trouble-cleared' &&
            membership === 'listed' &&
            intent.folded &&
            intent.admittedAsTrouble &&
            !open &&
            troubleCleared(intent)))
      )
    }
    const reveal = revealing.current
    if (reveal && newShown) {
      revealing.current = null
      if (mayHandOff(reveal)) {
        if (!tryFocus(reveal, newButton.current)) {
          fallback(reveal)
        }
      }
      if (document.activeElement !== newButton.current) {
        setNewShown(false)
      }
    }
    for (const [opId, entry] of followed.current) {
      if (!ownsFocus(entry, section.current, deletion)) {
        followed.current.delete(opId)
        continue
      }
      const button = rows.get(entry.intent.rowKey)
      const stillPending = deletion.pending.get(entry.intent.id)?.opId === opId
      if (button) {
        entry.order = [...rows.keys()]
        if (stillPending) {
          entry.leftOtherwise = false
        }
      } else if (
        stillPending &&
        deletion.membership(entry.intent) === 'listed' &&
        !deletion.hidden.has(entry.intent.id)
      ) {
        entry.leftOtherwise = true
      }
      if (entry.awaitingClose) {
        continue
      }
      if (entry.restoreRow) {
        entry.restoreRow = false
        if (button && !tryFocus(entry, button)) {
          tryFocus(entry, panelFallback.current)
        }
      }
      if (!entry.outcome) {
        continue
      }
      followed.current.delete(opId)
      if (!mayHandOff(entry)) {
        continue
      }
      const at = entry.order.indexOf(entry.intent.rowKey)
      const before = at === -1 ? 0 : entry.order.slice(0, at).filter((key) => rows.has(key)).length
      const buttons = [...rows.values()]
      if (tryFocus(entry, buttons[before]) || tryFocus(entry, buttons[before - 1])) {
        continue
      }
      if (open && !deletion.offline) {
        revealing.current = entry
        setNewShown(true)
      } else {
        fallback(entry)
      }
    }
  }, [deletion, newShown, open, panelFallback, revision, troubleCleared])

  return { section, newButton, newShown, setNewShown, follow, onCloseAutoFocus }
}
