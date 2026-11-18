import { useEffect, useRef, useSyncExternalStore } from 'react'
import { TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import {
  dismissWorktreeBaseFallbackNotice,
  getWorktreeBaseFallbackNotice,
  subscribeWorktreeBaseFallbackNotice
} from './worktree-base-fallback-notice'

export default function WorktreeBaseFallbackDialog(): React.JSX.Element {
  const t = useTranslate()
  const notice = useSyncExternalStore(
    subscribeWorktreeBaseFallbackNotice,
    getWorktreeBaseFallbackNotice,
    getWorktreeBaseFallbackNotice
  )
  const activeModal = useAppStore((state) => state.activeModal)
  const setContextualToursBlockingSurfaceVisible = useAppStore(
    (state) => state.setContextualToursBlockingSurfaceVisible
  )
  const lastNoticeRef = useRef(notice)
  const displayedNotice = notice ?? lastNoticeRef.current
  const open = notice !== null && activeModal === 'none'

  useEffect(() => {
    if (notice) {
      lastNoticeRef.current = notice
    }
  }, [notice])

  useEffect(() => {
    setContextualToursBlockingSurfaceVisible(open)
    return () => setContextualToursBlockingSurfaceVisible(false)
  }, [open, setContextualToursBlockingSurfaceVisible])

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          dismissWorktreeBaseFallbackNotice()
        }
      }}
    >
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <TriangleAlert className="size-4 text-muted-foreground" aria-hidden="true" />
            {t(
              'auto.components.WorktreeBaseFallbackDialog.title',
              'Workspace created from a local base'
            )}
          </DialogTitle>
          {displayedNotice ? (
            <DialogDescription className="text-xs leading-relaxed">
              {t(
                'auto.components.WorktreeBaseFallbackDialog.description',
                'The remote-tracking ref "{{value0}}" was unavailable, so Orca used local "{{value1}}" instead. This workspace may not include the latest remote changes.',
                { value0: displayedNotice.requestedRef, value1: displayedNotice.localRef }
              )}
            </DialogDescription>
          ) : null}
        </DialogHeader>
        <DialogFooter>
          <Button type="button" size="sm" autoFocus onClick={dismissWorktreeBaseFallbackNotice}>
            {t('auto.components.WorktreeBaseFallbackDialog.dismiss', 'Got it')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
