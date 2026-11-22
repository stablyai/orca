import { useRef, useState } from 'react'
import { Check, ExternalLink, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useConfirmationDialog } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { useBotSettingsLeaveGuard } from '@/components/bots/settings-view/bot-settings-leave-guard'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { BotFileChangedNotice } from './BotFileChangedNotice'
import { BotSoulPreview } from './BotSoulPreview'
import type { BotHomeFile } from './use-bot-home-file'
import { useSaveOnClose } from './use-save-on-close'

const SOUL_FILE = 'SOUL.md'

/** SOUL.md editorial document card: Read preview by default, Edit saves on blur and close. */
export function BotSoulEditor({
  file,
  label,
  onOpenAsFile,
  defaultMode
}: {
  file: BotHomeFile & { disk: string }
  label: string
  onOpenAsFile?: () => void
  defaultMode?: 'read' | 'edit'
}): React.JSX.Element {
  const t = useTranslate()
  // `base` is the disk text the draft started from; disk moving away from it is someone else's write.
  const [base, setBase] = useState(file.disk)
  const [draft, setDraft] = useState(file.disk)
  // The text being written, whose arrival on disk is ours, not someone else's.
  const [saving, setSaving] = useState<string | null>(null)
  const [mode, setMode] = useState<'read' | 'edit'>(
    defaultMode ?? (file.disk.trim() ? 'read' : 'edit')
  )
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const dirty = draft !== base
  const diskMoved = file.disk !== base && file.disk !== saving
  if (diskMoved && !dirty) {
    setBase(file.disk)
    setDraft(file.disk)
  }
  const changedOnDisk = diskMoved && dirty
  const effectiveMode = changedOnDisk ? 'edit' : mode

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

  const enterEdit = (): void => {
    setMode('edit')
    requestAnimationFrame(() => textareaRef.current?.focus())
  }
  const enterRead = (): void => {
    if (unsaved && !changedOnDisk) {
      void save(draft, over)
    }
    setMode('read')
  }

  // Leaving would drop the draft "Keep mine" could keep, so Back and Escape ask first; dismissing stays.
  const confirm = useConfirmationDialog()
  useBotSettingsLeaveGuard(
    changedOnDisk
      ? async () => {
          let theirs = false
          const mine = await confirm({
            title: t('settings.bots.fileChangedOnDisk', '{{file}} changed on disk.', {
              file: SOUL_FILE
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

  const lines = draft ? draft.split('\n').length : 0
  const words = draft.trim() ? draft.trim().split(/\s+/).length : 0
  const openAsFileLabel = t('bots.settingsView.openAsFile', 'Open as file')

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5">
      {changedOnDisk ? (
        <BotFileChangedNotice
          fileName={SOUL_FILE}
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

      <div
        className={cn(
          'flex min-h-[360px] flex-1 flex-col overflow-hidden rounded-[10px] transition-colors',
          effectiveMode === 'edit'
            ? 'border border-border bg-background focus-within:border-ring'
            : 'bg-foreground/[0.035]'
        )}
      >
        <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3">
          <div className="flex min-w-0 items-center gap-2">
            <code className="truncate font-mono text-xs text-foreground/85">{SOUL_FILE}</code>
            <span className="inline-flex shrink-0 items-center gap-1 text-2xs text-muted-foreground">
              {saving !== null ? (
                <>
                  <Loader2 className="size-3 animate-spin" />
                  {t('settings.bots.saving', 'Saving…')}
                </>
              ) : dirty ? (
                t('settings.bots.unsaved', 'Unsaved')
              ) : (
                <>
                  <Check className="size-3" />
                  {t('settings.bots.saved', 'Saved')}
                </>
              )}
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <div
              role="tablist"
              aria-label={t('settings.bots.soulView', 'Soul view')}
              className="inline-flex h-7 items-center rounded-md bg-foreground/[0.06] p-0.5 text-2xs"
            >
              <button
                type="button"
                role="tab"
                aria-selected={effectiveMode === 'read'}
                disabled={changedOnDisk}
                onClick={enterRead}
                className={cn(
                  'inline-flex h-6 items-center rounded-[5px] px-2.5 font-medium transition-colors disabled:opacity-50',
                  effectiveMode === 'read'
                    ? 'bg-background text-foreground shadow-xs dark:bg-foreground/[0.14] dark:shadow-none'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {t('settings.bots.soulRead', 'Read')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={effectiveMode === 'edit'}
                onClick={enterEdit}
                className={cn(
                  'inline-flex h-6 items-center rounded-[5px] px-2.5 font-medium transition-colors',
                  effectiveMode === 'edit'
                    ? 'bg-background text-foreground shadow-xs dark:bg-foreground/[0.14] dark:shadow-none'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {t('settings.bots.soulEdit', 'Edit')}
              </button>
            </div>

            {onOpenAsFile ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="muted-field-icon"
                    size="icon-xs"
                    aria-label={openAsFileLabel}
                    onClick={onOpenAsFile}
                  >
                    <ExternalLink className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={4}>
                  {openAsFileLabel}
                </TooltipContent>
              </Tooltip>
            ) : null}
          </div>
        </div>

        {effectiveMode === 'read' ? (
          <div
            className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto px-4 py-4"
            onDoubleClick={enterEdit}
          >
            <BotSoulPreview content={draft} />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 px-4 py-3.5">
            <Textarea
              ref={textareaRef}
              variant="composite"
              aria-label={label}
              value={draft}
              rows={12}
              className="min-h-0 flex-1"
              onFocus={() => void file.refresh()}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && !event.nativeEvent.isComposing && !changedOnDisk) {
                  event.stopPropagation()
                  enterRead()
                }
              }}
              onBlur={() => {
                if (unsaved && !changedOnDisk) {
                  void save(draft, over)
                }
              }}
            />
          </div>
        )}

        <div className="flex h-8 shrink-0 items-center justify-between border-t border-border/60 px-3 text-2xs text-muted-foreground">
          <span className="tabular-nums">
            {t('settings.bots.soulStats', '{{lines}} lines · {{words}} words', { lines, words })}
          </span>
          {effectiveMode === 'read' ? (
            <span>{t('settings.bots.soulDoubleClickHint', 'Double-click to edit')}</span>
          ) : null}
        </div>
      </div>
    </div>
  )
}
