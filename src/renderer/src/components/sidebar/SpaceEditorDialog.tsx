import React from 'react'
import { useAppStore } from '@/store'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { isImeCompositionKeyDown } from '@/lib/ime-composition-keyboard-event'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'
import { limitSpaceName } from '../../../../shared/spaces'
import { SpaceEmojiPickerPopover } from './SpaceEmojiPickerPopover'

type SpaceDraft = { name: string; emoji: string | null }

const EMPTY_DRAFT: SpaceDraft = { name: '', emoji: null }

export default function SpaceEditorDialog(): React.JSX.Element | null {
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const spaces = useAppStore((s) => s.spaces)
  const createSpace = useAppStore((s) => s.createSpace)
  const updateSpace = useAppStore((s) => s.updateSpace)

  const open = activeModal === 'space-editor'
  const spaceId = typeof modalData.spaceId === 'string' ? modalData.spaceId : null
  const editedSpace = spaces.find((entry) => entry.id === spaceId) ?? null
  const editedSpaceId = editedSpace?.id ?? null
  const editedSpaceName = editedSpace?.name ?? ''
  const editedSpaceEmoji = editedSpace?.emoji ?? null

  const [draft, setDraft] = React.useState<SpaceDraft>(() =>
    editedSpace ? { name: editedSpace.name, emoji: editedSpace.emoji } : EMPTY_DRAFT
  )
  const [saving, setSaving] = React.useState(false)
  const [saveFailed, setSaveFailed] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const mountedRef = React.useRef(true)
  const nameInputId = React.useId()

  React.useEffect(() => {
    if (!open) {
      return
    }
    setDraft(editedSpaceId ? { name: editedSpaceName, emoji: editedSpaceEmoji } : EMPTY_DRAFT)
    setSaveFailed(false)
  }, [editedSpaceEmoji, editedSpaceId, editedSpaceName, open])

  React.useEffect(() => {
    // Why: StrictMode reuses the ref across its mount/unmount/remount, so this must re-arm on mount.
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const trimmedName = draft.name.trim()

  const handleSubmit = React.useCallback(
    async (event?: React.FormEvent<HTMLFormElement>) => {
      event?.preventDefault()
      if (!trimmedName || saving) {
        return
      }
      setSaveFailed(false)
      setSaving(true)
      const values = { name: trimmedName, emoji: draft.emoji }
      const saved = await (editedSpace ? updateSpace(editedSpace.id, values) : createSpace(values))
      if (mountedRef.current) {
        if (saved) {
          closeModal()
        } else {
          setSaving(false)
          setSaveFailed(true)
        }
      }
    },
    [closeModal, createSpace, draft.emoji, editedSpace, saving, trimmedName, updateSpace]
  )

  if (!open) {
    return null
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !saving) {
          closeModal()
        }
      }}
    >
      <DialogContent
        className="max-w-sm sm:max-w-sm"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          inputRef.current?.focus()
          inputRef.current?.select()
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-sm">
            {editedSpace
              ? translate('auto.components.sidebar.SpaceEditorDialog.editTitle', 'Edit Space')
              : translate('auto.components.sidebar.SpaceEditorDialog.createTitle', 'New Space')}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {translate(
              'auto.components.sidebar.SpaceEditorDialog.description',
              'A Space decides which projects the sidebar shows.'
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={handleSubmit}
          // Why: an Enter that only confirms a CJK IME candidate must not submit the Space.
          onKeyDown={(event) => {
            if (event.key === 'Enter' && isImeCompositionKeyDown(event)) {
              event.preventDefault()
            }
          }}
        >
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1 space-y-1">
              <Label htmlFor={nameInputId} className="text-[11px] text-muted-foreground">
                {translate('auto.components.sidebar.SpaceEditorDialog.nameLabel', 'Name')}
              </Label>
              <Input
                id={nameInputId}
                ref={inputRef}
                value={draft.name}
                disabled={saving}
                placeholder={translate(
                  'auto.components.sidebar.SpaceEditorDialog.namePlaceholder',
                  'Space name'
                )}
                onChange={(event) =>
                  setDraft((prev) => ({ ...prev, name: limitSpaceName(event.target.value) }))
                }
                className="h-8 text-xs"
              />
            </div>
            <SpaceEmojiPickerPopover
              emoji={draft.emoji}
              disabled={saving}
              onEmojiSelect={(emoji) => setDraft((prev) => ({ ...prev, emoji }))}
            />
          </div>
          {saveFailed ? (
            <p role="alert" className="text-xs text-destructive">
              {translate(
                'auto.components.sidebar.SpaceEditorDialog.saveFailed',
                "Couldn't save the Space. Try again."
              )}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-xs"
              disabled={saving}
              onClick={closeModal}
            >
              {translate('auto.components.sidebar.SpaceEditorDialog.cancel', 'Cancel')}
            </Button>
            <Button type="submit" size="sm" className="text-xs" disabled={!trimmedName || saving}>
              {editedSpace
                ? translate('auto.components.sidebar.SpaceEditorDialog.save', 'Save')
                : translate('auto.components.sidebar.SpaceEditorDialog.create', 'Create Space')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
