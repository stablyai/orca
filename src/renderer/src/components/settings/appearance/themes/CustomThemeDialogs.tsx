import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useTranslate } from '@/i18n/use-translate'

const MAX_NAME_LENGTH = 64

function RenameForm({
  name,
  onClose,
  onRename
}: {
  name: string
  onClose: () => void
  onRename: (name: string) => Promise<void>
}): React.JSX.Element {
  const t = useTranslate()
  const [value, setValue] = useState(name)
  const [busy, setBusy] = useState(false)
  const trimmed = value.trim()
  const ready = trimmed.length > 0 && trimmed !== name && !busy
  const submit = async (): Promise<void> => {
    if (!ready) {
      return
    }
    setBusy(true)
    await onRename(trimmed)
    onClose()
  }
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {t('settings.appearance.customTheme.renameTitle', 'Rename theme')}
        </DialogTitle>
      </DialogHeader>
      <Input
        autoFocus
        value={value}
        maxLength={MAX_NAME_LENGTH}
        aria-label={t('settings.appearance.customTheme.nameLabel', 'Theme name')}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            void submit()
          }
        }}
      />
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          {t('settings.appearance.customTheme.cancel', 'Cancel')}
        </Button>
        <Button disabled={!ready} onClick={() => void submit()}>
          {t('settings.appearance.customTheme.renameAction', 'Rename')}
        </Button>
      </DialogFooter>
    </>
  )
}

export function CustomThemeRenameDialog({
  open,
  name,
  onClose,
  onRename
}: {
  open: boolean
  name: string
  onClose: () => void
  onRename: (name: string) => Promise<void>
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-sm">
        {/* Why mounted only while open: each opening starts from the current name. */}
        {open ? <RenameForm name={name} onClose={onClose} onRename={onRename} /> : null}
      </DialogContent>
    </Dialog>
  )
}

export function CustomThemeDeleteDialog({
  open,
  name,
  onClose,
  onDelete
}: {
  open: boolean
  name: string
  onClose: () => void
  onDelete: () => Promise<void>
}): React.JSX.Element {
  const t = useTranslate()
  const [busy, setBusy] = useState(false)
  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {t('settings.appearance.customTheme.deleteTitle', 'Delete {{name}}?', { name })}
          </DialogTitle>
          <DialogDescription>
            {t(
              'settings.appearance.customTheme.deleteDescription',
              'Orca goes back to the theme you had before, or its built-in theme. Export it first to keep a copy.'
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t('settings.appearance.customTheme.cancel', 'Cancel')}
          </Button>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              void onDelete().finally(() => {
                setBusy(false)
                onClose()
              })
            }}
          >
            {t('settings.appearance.customTheme.deleteAction', 'Delete theme')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
