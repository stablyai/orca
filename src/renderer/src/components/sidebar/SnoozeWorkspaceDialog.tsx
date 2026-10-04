import React, { useId, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { snoozeWorkspaces, type SnoozeTarget } from './workspace-snooze-flow'
import {
  parseDatetimeLocalValue,
  resolveWorkspaceSnoozePresetWakeAt,
  toDatetimeLocalValue
} from './workspace-snooze-presets'

type SnoozeWorkspaceModalData = { targets: SnoozeTarget[] }

function isSnoozeModalData(data: unknown): data is SnoozeWorkspaceModalData {
  if (!data || typeof data !== 'object' || !('targets' in data)) {
    return false
  }
  const { targets } = data
  return (
    Array.isArray(targets) &&
    targets.length > 0 &&
    targets.every(
      (target: unknown) =>
        typeof target === 'object' &&
        target !== null &&
        'id' in target &&
        typeof target.id === 'string'
    )
  )
}

export default function SnoozeWorkspaceDialog(): React.JSX.Element | null {
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const inputId = useId()
  const [openedAt] = useState(() => Date.now())
  const [value, setValue] = useState(() =>
    toDatetimeLocalValue(resolveWorkspaceSnoozePresetWakeAt('tomorrow-morning', new Date(openedAt)))
  )
  if (!isSnoozeModalData(modalData)) {
    return null
  }
  const wakeAt = parseDatetimeLocalValue(value)
  const valid = wakeAt !== null && wakeAt > openedAt

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (wakeAt === null || wakeAt <= Date.now()) {
      return
    }
    closeModal()
    void snoozeWorkspaces(modalData.targets, wakeAt)
  }

  return (
    <Dialog open onOpenChange={(open) => !open && closeModal()}>
      <DialogContent className="max-w-sm sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {translate('auto.components.sidebar.SnoozeWorkspaceDialog.title', 'Snooze Until')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.sidebar.SnoozeWorkspaceDialog.description',
              'The workspace sleeps and hides from the sidebar, then returns as unread at this time.'
            )}
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-1">
            <Label htmlFor={inputId}>
              {translate('auto.components.sidebar.SnoozeWorkspaceDialog.wakeAt', 'Wake At')}
            </Label>
            <Input
              id={inputId}
              type="datetime-local"
              autoFocus
              value={value}
              min={toDatetimeLocalValue(openedAt)}
              onChange={(event) => setValue(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={closeModal}>
              {translate('auto.components.sidebar.SnoozeWorkspaceDialog.cancel', 'Cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={!valid}>
              {translate('auto.components.sidebar.SnoozeWorkspaceDialog.confirm', 'Snooze')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
