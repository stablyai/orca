import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useConfirmationDialog } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { useBotSettingsLeaveGuard } from '@/components/bots/settings-view/bot-settings-leave-guard'
import { useTranslate } from '@/i18n/use-translate'
import { BotFileChangedNotice } from './BotFileChangedNotice'
import type { BotHomeFile } from './use-bot-home-file'
import { useSaveOnClose } from './use-save-on-close'

/** SOUL.md, saved when the editor loses focus. */
export function BotSoulEditor({
  file,
  label
}: {
  file: BotHomeFile & { disk: string }
  label: string
}): React.JSX.Element {
  const t = useTranslate()
  // `base` is the disk text the draft started from; disk moving away from it is someone else's write.
  const [base, setBase] = useState(file.disk)
  const [draft, setDraft] = useState(file.disk)
  // The text being written, whose arrival on disk is ours, not someone else's.
  const [saving, setSaving] = useState<string | null>(null)
  const dirty = draft !== base
  const diskMoved = file.disk !== base && file.disk !== saving
  if (diskMoved && !dirty) {
    setBase(file.disk)
    setDraft(file.disk)
  }
  const changedOnDisk = diskMoved && dirty

  // A save made while another is in flight builds on that one's text, and is needed only if the draft differs from it.
  const over = saving ?? base
  const unsaved = draft !== over
  const save = async (next: string, expected: string): Promise<void> => {
    setSaving(next)
    if ((await file.write(next, expected)) === 'saved') {
      setBase(next)
    }
    setSaving((current) => (current === next ? null : current))
  }
  useSaveOnClose(unsaved && !changedOnDisk ? () => void file.write(draft, over) : null)
  const takeTheirs = (): void => {
    setBase(file.disk)
    setDraft(file.disk)
  }
  // Leaving would drop the draft "Keep mine" could keep, so Back and Escape ask first; dismissing stays.
  const confirm = useConfirmationDialog()
  useBotSettingsLeaveGuard(
    changedOnDisk
      ? async () => {
          let theirs = false
          const mine = await confirm({
            title: t('settings.bots.fileChangedOnDisk', '{{file}} changed on disk.', {
              file: 'SOUL.md'
            }),
            description: t(
              'bots.settingsView.soulLeaveDescription',
              'Keep your edit or use the file as it is now before you leave.'
            ),
            confirmLabel: t('settings.bots.keepMine', 'Keep mine'),
            cancelLabel: t('settings.bots.useTheirs', 'Use theirs'),
            onCancelClicked: () => {
              theirs = true
            }
          })
          if (mine) {
            return (await file.write(draft, file.disk)) === 'saved'
          }
          if (theirs) {
            takeTheirs()
          }
          return theirs
        }
      : null
  )

  return (
    <div className="space-y-2">
      {changedOnDisk ? (
        <BotFileChangedNotice
          fileName="SOUL.md"
          actions={
            <>
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={saving !== null}
                onClick={takeTheirs}
              >
                {t('settings.bots.useTheirs', 'Use theirs')}
              </Button>
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={saving !== null}
                onClick={() => void save(draft, file.disk)}
              >
                {t('settings.bots.keepMine', 'Keep mine')}
              </Button>
            </>
          }
        />
      ) : null}
      <Textarea
        variant="code"
        aria-label={label}
        value={draft}
        rows={10}
        onFocus={() => void file.refresh()}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (unsaved && !changedOnDisk) {
            void save(draft, over)
          }
        }}
      />
    </div>
  )
}
