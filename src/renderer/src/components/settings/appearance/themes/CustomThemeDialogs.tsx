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

export function CustomThemeRenameDialog({
  open,
  name,
  onClose,
  onRename
}: {
  open: boolean
  name: string
  onClose: () => void
  onRename: (name: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [value, setValue] = useState(name)
  const trimmed = value.trim()
  const submit = (): void => {
    if (trimmed && trimmed !== name) {
      onRename(trimmed)
    }
    onClose()
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setValue(name)
        } else {
          onClose()
        }
      }}
    >
      <DialogContent className="sm:max-w-sm">
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
            if (event.key === 'Enter') {
              submit()
            }
          }}
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('settings.appearance.customTheme.cancel', 'Cancel')}
          </Button>
          <Button disabled={!trimmed || trimmed === name} onClick={submit}>
            {t('settings.appearance.customTheme.renameAction', 'Rename')}
          </Button>
        </DialogFooter>
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
  onDelete: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
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
          <Button variant="outline" onClick={onClose}>
            {t('settings.appearance.customTheme.cancel', 'Cancel')}
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              onDelete()
              onClose()
            }}
          >
            {t('settings.appearance.customTheme.deleteAction', 'Delete theme')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
