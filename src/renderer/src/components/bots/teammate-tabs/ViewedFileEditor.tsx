// A file in another person's Home list: read from disk on the agent's host and saved back only if
// disk still holds the text the edit started from (`files.writeIfUnchanged`). A stale save is refused,
// and the editor shows the change instead of writing over it. Unsaved edits stay in this window.
import { useState } from 'react'
import { Check, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../../shared/bot-types'
import { BotFileChangedNotice } from '../../settings/bots/BotFileChangedNotice'
import type { BotHome } from '../../settings/bots/bot-home-files'
import { type BotHomeFile, useBotHome, useBotHomeFile } from '../../settings/bots/use-bot-home-file'

function Notice({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}

function FileEditor({
  file,
  relativePath
}: {
  file: BotHomeFile & { disk: string }
  relativePath: string
}): React.JSX.Element {
  const t = useTranslate()
  // `base` is the disk text the draft started from; disk moving off it is someone else's save.
  const [base, setBase] = useState(file.disk)
  const [draft, setDraft] = useState(file.disk)
  const [saving, setSaving] = useState<string | null>(null)
  const dirty = draft !== base
  const diskMoved = file.disk !== base && file.disk !== saving
  if (diskMoved && !dirty) {
    setBase(file.disk)
    setDraft(file.disk)
  }
  const changedOnDisk = diskMoved && dirty
  const save = async (next: string, expected: string): Promise<void> => {
    setSaving(next)
    if ((await file.write(next, expected)) === 'saved') {
      setBase(next)
    }
    setSaving((current) => (current === next ? null : current))
  }
  const useTheirs = (): void => {
    setBase(file.disk)
    setDraft(file.disk)
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3">
        <code className="truncate font-mono text-xs text-foreground/85">{relativePath}</code>
        <div className="flex shrink-0 items-center gap-2">
          <span className="inline-flex items-center gap-1 text-2xs text-muted-foreground">
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
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={!dirty || changedOnDisk || saving !== null}
            onClick={() => void save(draft, base)}
          >
            {t('bots.teammateTabs.save', 'Save')}
          </Button>
        </div>
      </div>
      {changedOnDisk ? (
        <div className="shrink-0 p-2">
          <BotFileChangedNotice
            fileName={relativePath}
            actions={
              <>
                <Button type="button" size="xs" variant="outline" onClick={useTheirs}>
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
        </div>
      ) : null}
      <div className="scrollbar-sleek min-h-0 flex-1 px-4 py-3">
        <Textarea
          variant="composite"
          aria-label={relativePath}
          spellCheck={false}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) {
              return
            }
            const modifier = navigator.userAgent.includes('Mac') ? event.metaKey : event.ctrlKey
            if (modifier && event.key.toLowerCase() === 's') {
              event.preventDefault()
              if (dirty && !changedOnDisk && saving === null) {
                void save(draft, base)
              }
            }
          }}
          className="h-full"
        />
      </div>
    </div>
  )
}

function HomeFile({ home, relativePath }: { home: BotHome; relativePath: string }) {
  const t = useTranslate()
  const file = useBotHomeFile(home, relativePath)
  if (file.readError !== null && file.disk === null) {
    return (
      <Notice>
        {t('bots.teammateTabs.fileUnreadable', 'Could not read {{path}}.', { path: relativePath })}
      </Notice>
    )
  }
  if (file.disk === null) {
    return (
      <Notice>
        {t('bots.teammateTabs.fileReading', 'Reading {{path}}…', { path: relativePath })}
      </Notice>
    )
  }
  // A new path is a new draft.
  return (
    <FileEditor
      key={relativePath}
      file={{ ...file, disk: file.disk }}
      relativePath={relativePath}
    />
  )
}

export function ViewedFileEditor({
  bot,
  relativePath
}: {
  bot: Pick<Bot, 'hostId' | 'folderWorkspaceId'>
  relativePath: string
}): React.JSX.Element {
  const t = useTranslate()
  const home = useBotHome(bot)
  if (!home) {
    return (
      <Notice>
        {t('bots.teammateTabs.fileReading', 'Reading {{path}}…', { path: relativePath })}
      </Notice>
    )
  }
  return <HomeFile key={relativePath} home={home} relativePath={relativePath} />
}
