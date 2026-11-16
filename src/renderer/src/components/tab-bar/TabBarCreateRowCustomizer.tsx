import React, { useRef } from 'react'
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Eye, EyeOff, GripVertical, Keyboard, Lock, MoreVertical, RotateCcw } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { ShortcutRecorderButton } from '../settings/shortcuts/ShortcutRecorderButton'
import { useKeybindingActionEditor } from '../settings/shortcuts/use-keybinding-action-editor'
import type { KeybindingActionId, KeybindingInput } from '../../../../shared/keybindings/types'
import type { TabBarCreateRowItem } from './tab-bar-create-row-item'

const HIDDEN_DIVIDER_ID = 'create-row:hidden'

type Editor = ReturnType<typeof useKeybindingActionEditor>
type Recorder = {
  start: (actionId: KeybindingActionId) => void
  cancel: () => void
  capture: (actionId: KeybindingActionId, input: KeybindingInput) => void
}

export function TabBarCreateRowCustomizer({
  visible,
  hidden,
  recordingActionId,
  onRecordingChange,
  onArrange,
  onReset,
  onOpenShortcutSettings
}: {
  visible: readonly TabBarCreateRowItem[]
  hidden: readonly TabBarCreateRowItem[]
  recordingActionId: KeybindingActionId | null
  onRecordingChange: (actionId: KeybindingActionId | null) => void
  onArrange: (visibleIds: string[], hiddenIds: string[]) => void
  onReset: () => void
  onOpenShortcutSettings: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const editor = useKeybindingActionEditor()
  // Why: a save that lands after the user restarted or cancelled recording must not end the new session.
  const recordingSession = useRef(0)
  const recorder: Recorder = {
    start: (actionId) => {
      recordingSession.current += 1
      editor.clearErrors()
      onRecordingChange(actionId)
    },
    cancel: () => {
      recordingSession.current += 1
      onRecordingChange(null)
    },
    capture: (actionId, input) => {
      const session = recordingSession.current
      void editor.captureBinding(actionId, input, 0).then((saved) => {
        if (saved && recordingSession.current === session) {
          onRecordingChange(null)
        }
      })
    }
  }
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))
  // Why: reordering moves the focused row's DOM node, which drops focus; restore it after commit.
  const focusAfterMove = useRef<string | null>(null)
  const ids = [
    ...visible.map((item) => item.id),
    HIDDEN_DIVIDER_ID,
    ...hidden.map((item) => item.id)
  ]
  const lockedIds = new Set([...visible, ...hidden].filter((item) => item.locked).map((i) => i.id))

  /** Saves the arrangement unless it would hide a locked item; returns whether it saved. */
  const commit = (nextIds: string[]): boolean => {
    const divider = nextIds.indexOf(HIDDEN_DIVIDER_ID)
    const nextHidden = nextIds.slice(divider + 1)
    if (nextHidden.some((id) => lockedIds.has(id))) {
      return false
    }
    onArrange(nextIds.slice(0, divider), nextHidden)
    return true
  }
  const move = (id: string, delta: number): void => {
    const from = ids.indexOf(id)
    const to = from + delta
    if (from === -1 || to < 0 || to >= ids.length) {
      return
    }
    if (commit(arrayMove(ids, from, to))) {
      focusAfterMove.current = id
    }
  }
  const toggle = (id: string, isVisible: boolean): void => {
    const visibleIds = visible.map((item) => item.id).filter((other) => other !== id)
    const hiddenIds = hidden.map((item) => item.id).filter((other) => other !== id)
    focusAfterMove.current = id
    if (isVisible) {
      onArrange(visibleIds, [id, ...hiddenIds])
    } else {
      onArrange([...visibleIds, id], hiddenIds)
    }
  }
  const focusRestoringRef =
    (id: string, setNodeRef: (node: HTMLElement | null) => void) => (node: HTMLElement | null) => {
      setNodeRef(node)
      if (node && focusAfterMove.current === id) {
        focusAfterMove.current = null
        node.focus({ preventScroll: true })
      }
    }

  const renderRow = (item: TabBarCreateRowItem, isVisible: boolean) => (
    <CustomizerRow
      key={item.id}
      item={item}
      isVisible={isVisible}
      editor={editor}
      recordingActionId={recordingActionId}
      recorder={recorder}
      onToggle={() => toggle(item.id, isVisible)}
      onMove={(delta) => move(item.id, delta)}
      refFor={focusRestoringRef}
    />
  )

  return (
    <>
      <div className="flex items-center justify-between pr-1">
        <DropdownMenuLabel>{t('tabBar.createRow.shownLabel', 'In the + menu')}</DropdownMenuLabel>
        {/* Rarely used, so they stay out of the list's way behind ⋮. */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger
            variant="header-chip"
            hideChevron
            aria-label={t('tabBar.createRow.moreOptions', 'More options')}
          >
            <MoreVertical className="size-3.5" />
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault()
                onReset()
              }}
            >
              <RotateCcw />
              {t('tabBar.createRow.reset', 'Reset Order')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onOpenShortcutSettings}>
              <Keyboard />
              {t('tabBar.createRow.allShortcuts', 'All Keyboard Shortcuts…')}
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={({ active, over }) => {
          if (!over || active.id === over.id) {
            return
          }
          commit(arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id))))
        }}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {visible.map((item) => renderRow(item, true))}
          <HiddenDivider empty={hidden.length === 0} />
          {hidden.map((item) => renderRow(item, false))}
        </SortableContext>
      </DndContext>
      <p className="px-2.5 pt-1 pb-1.5 text-2xs leading-4 text-muted-foreground">
        {t(
          'tabBar.createRow.hint',
          'Drag to reorder, or {{modifier}}↑/↓. Space shows or hides. Hidden items still open from search and their shortcuts.',
          { modifier: editor.platform === 'darwin' ? '⌥' : 'Alt+' }
        )}
      </p>
    </>
  )
}

function HiddenDivider({ empty }: { empty: boolean }): React.JSX.Element {
  const t = useTranslate()
  const { setNodeRef, transform, transition } = useSortable({
    id: HIDDEN_DIVIDER_ID,
    disabled: true
  })
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }}>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>{t('tabBar.createRow.hiddenLabel', 'Hidden')}</DropdownMenuLabel>
      {empty ? (
        <div className="mx-1 mb-1 flex h-7 items-center justify-center rounded-md border border-dashed border-border text-2xs text-muted-foreground">
          {t('tabBar.createRow.hiddenEmpty', 'Drag items here to hide them')}
        </div>
      ) : null}
    </div>
  )
}

function CustomizerRow({
  item,
  isVisible,
  editor,
  recordingActionId,
  recorder,
  onToggle,
  onMove,
  refFor
}: {
  item: TabBarCreateRowItem
  isVisible: boolean
  editor: Editor
  recordingActionId: KeybindingActionId | null
  recorder: Recorder
  onToggle: () => void
  onMove: (delta: number) => void
  refFor: (
    id: string,
    setNodeRef: (node: HTMLElement | null) => void
  ) => (node: HTMLElement | null) => void
}): React.JSX.Element {
  const t = useTranslate()
  const { setNodeRef, setActivatorNodeRef, listeners, transform, transition, isDragging } =
    useSortable({ id: item.id })
  const recorderRef = useRef<HTMLDivElement>(null)
  const actionId = item.actionId
  const bindings = actionId ? editor.effectiveBindingsForAction(actionId) : []
  const error = actionId ? editor.errors[actionId] : undefined
  const stopRowSelect = (event: React.SyntheticEvent) => event.stopPropagation()

  return (
    <>
      <DropdownMenuItem
        ref={refFor(item.id, setNodeRef)}
        role="menuitemcheckbox"
        aria-checked={isVisible}
        style={{ transform: CSS.Translate.toString(transform), transition }}
        variant="sortable"
        data-dragging={isDragging ? '' : undefined}
        onPointerMove={(event) => {
          // Why: Radix focuses rows under the pointer, which would pull keys away from a live recorder.
          if (recordingActionId !== null) {
            event.preventDefault()
          }
        }}
        onSelect={(event) => {
          event.preventDefault()
          if (!item.locked) {
            onToggle()
          }
        }}
        onKeyDown={(event) => {
          const onRow = event.target === event.currentTarget
          const recorder = recorderRef.current?.querySelector<HTMLElement>('button')
          if (onRow && event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
            event.preventDefault()
            event.stopPropagation()
            onMove(event.key === 'ArrowDown' ? 1 : -1)
          } else if (onRow && event.key === 'ArrowRight' && recorder) {
            event.preventDefault()
            event.stopPropagation()
            recorder.focus()
          } else if (
            !onRow &&
            ['ArrowLeft', 'ArrowUp', 'ArrowDown'].includes(event.key) &&
            !event.altKey
          ) {
            // Back to the row so Radix's roving focus keeps working from there.
            event.preventDefault()
            event.stopPropagation()
            event.currentTarget.focus()
          }
        }}
      >
        <span
          ref={setActivatorNodeRef}
          {...listeners}
          aria-hidden="true"
          className="flex h-5 w-4 cursor-grab items-center justify-center text-muted-foreground/60 hover:text-foreground active:cursor-grabbing"
          onClick={stopRowSelect}
        >
          <GripVertical className="size-3.5" />
        </span>
        <span className={cn('flex text-muted-foreground', !isVisible && 'opacity-60')}>
          {item.icon}
        </span>
        <span className={cn('min-w-0 flex-1 truncate', !isVisible && 'text-muted-foreground')}>
          {item.label}
          {item.detail ? (
            <span className="ml-1.5 text-2xs text-muted-foreground">{item.detail}</span>
          ) : null}
        </span>
        {actionId ? (
          <div ref={recorderRef} className="flex" onClick={stopRowSelect}>
            <ShortcutRecorderButton
              compact
              actionId={actionId}
              title={item.label}
              platform={editor.platform}
              isDigitIndex={false}
              binding={bindings[0] ?? null}
              bindingIndex={0}
              bindingCount={bindings.length}
              recording={recordingActionId === actionId}
              onStartRecording={recorder.start}
              onCancelRecording={recorder.cancel}
              onCapture={recorder.capture}
              onClearError={editor.clearError}
            />
          </div>
        ) : null}
        <span
          className="flex h-5 min-w-5 items-center justify-center text-muted-foreground"
          title={
            item.enable
              ? t('tabBar.createRow.turnOn', 'Turned off. Show it to turn it back on.')
              : item.locked
                ? t('tabBar.createRow.locked', 'Always shown')
                : isVisible
                  ? t('tabBar.createRow.hide', 'Hide')
                  : t('tabBar.createRow.show', 'Show')
          }
        >
          {item.enable ? (
            <span className="rounded border border-border px-1 text-2xs leading-4">
              {t('tabBar.createRow.featureOff', 'Off')}
            </span>
          ) : item.locked ? (
            <Lock className="size-3.5" />
          ) : isVisible ? (
            <Eye className="size-3.5" />
          ) : (
            <EyeOff className="size-3.5" />
          )}
        </span>
      </DropdownMenuItem>
      {error ? (
        <p role="alert" className="px-2.5 pb-1 pl-7 text-2xs leading-4 text-destructive">
          {error}
        </p>
      ) : null}
    </>
  )
}
