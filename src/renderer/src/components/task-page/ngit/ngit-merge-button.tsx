import { useState } from 'react'
import { GitMerge, LoaderCircle } from 'lucide-react'
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
import type { NgitWorkItem } from '../../../../../shared/ngit/ngit-work-item-types'

export function NgitMergeButton({
  item,
  disabled,
  merging,
  onMerge
}: {
  item: NgitWorkItem
  disabled: boolean
  merging: boolean
  onMerge: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [confirming, setConfirming] = useState(false)
  const label = t('components.taskPage.ngit.mergePr', 'Merge pull request')
  return (
    <>
      <Button size="sm" disabled={disabled} onClick={() => setConfirming(true)}>
        {merging ? <LoaderCircle className="size-3.5 animate-spin" /> : <GitMerge />}
        {label}
      </Button>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{label}</DialogTitle>
            <DialogDescription>
              {t(
                'components.taskPage.ngit.mergeWarning',
                'Creates a merge commit on {{branch}} and pushes it, publishing “{{title}}” as merged. This cannot be undone.',
                {
                  branch:
                    item.baseRefName ??
                    t('components.taskPage.ngit.defaultBranch', 'the default branch'),
                  title: item.title
                }
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)}>
              {t('components.taskPage.ngit.cancel', 'Cancel')}
            </Button>
            <Button
              onClick={() => {
                setConfirming(false)
                onMerge()
              }}
            >
              {t('components.taskPage.ngit.confirmMerge', 'Merge and push')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
