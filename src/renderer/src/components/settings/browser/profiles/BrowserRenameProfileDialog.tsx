import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '../../../ui/button'
import { Input } from '../../../ui/input'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../../../ui/dialog'
import { useAppStore } from '../../../../store/index'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useTranslate } from '@/i18n/use-translate'
import type { BrowserSessionProfile } from '../../../../../../shared/browser/workspaces/browser-workspace-types'
import { translateBrowserSessionProfileLabel } from '@/lib/browser/profiles/browser-session-profile-label'

type BrowserRenameProfileDialogProps = {
  /** The profile being renamed; null keeps the dialog closed. */
  profile: BrowserSessionProfile | null
  onOpenChange: (open: boolean) => void
}

export function BrowserRenameProfileDialog({
  profile,
  onOpenChange
}: BrowserRenameProfileDialogProps): React.JSX.Element {
  const t = useTranslate()
  const mountedRef = useMountedRef()
  const [label, setLabel] = useState('')
  const [isRenaming, setIsRenaming] = useState(false)
  // Prefill on open only: a profile-list refresh must not overwrite what the person is typing.
  const editingProfileId = useRef<string | null>(null)

  useEffect(() => {
    if (profile && editingProfileId.current !== profile.id) {
      setLabel(translateBrowserSessionProfileLabel(profile.label, profile.id))
    }
    editingProfileId.current = profile?.id ?? null
  }, [profile])

  return (
    <Dialog
      open={profile !== null}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onOpenChange(false)
        }
      }}
    >
      <DialogContent className="sm:max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t('browser.profile.renameTitle', 'Rename browser profile')}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={async (e) => {
            e.preventDefault()
            const trimmed = label.trim()
            if (!profile || !trimmed) {
              return
            }
            setIsRenaming(true)
            try {
              const renamed = await useAppStore
                .getState()
                .renameBrowserSessionProfile(profile.id, trimmed)
              if (!mountedRef.current) {
                return
              }
              if (renamed) {
                toast.success(
                  t('browser.profile.renamed', 'Profile "{{value0}}" renamed to "{{value1}}".', {
                    value0: translateBrowserSessionProfileLabel(profile.label, profile.id),
                    value1: renamed.label
                  })
                )
                onOpenChange(false)
              } else {
                toast.error(t('browser.profile.renameFailed', 'Failed to rename profile.'))
              }
            } finally {
              if (mountedRef.current) {
                setIsRenaming(false)
              }
            }
          }}
        >
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t('browser.profile.namePlaceholder', 'Profile name')}
            autoFocus
            maxLength={50}
            className="mb-3"
          />
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={!label.trim() || isRenaming}>
              {isRenaming
                ? t('browser.profile.renaming', 'Renaming…')
                : t('browser.profile.renameSubmit', 'Rename')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
