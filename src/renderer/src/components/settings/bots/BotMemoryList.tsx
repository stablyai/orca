import { useState } from 'react'
import { ArrowUpRight, ExternalLink, Pencil, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { SettingsInsetGroup } from '@/components/bots/settings-view/BotSettingsRows'
import { getIntlLocale } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import {
  BOT_MEMORY_INDEX_LINE_CAP,
  type BotMemoryFact,
  botMemorySourceLink,
  countBotMemoryLines,
  findBotMemoryFact,
  parseBotMemoryFacts
} from '../../../../../shared/bot-memory-lines'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import { toast } from 'sonner'
import { botErrorMessage } from '@/components/bots/bot-presentation'
import type { BotHomeFile } from './use-bot-home-file'
import { useSaveOnClose } from './use-save-on-close'

function shortDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year, month - 1, day).toLocaleDateString(getIntlLocale(), {
    month: 'short',
    day: 'numeric'
  })
}

function FactSource({ source }: { source: string }): React.JSX.Element {
  const t = useTranslate()
  const { text, url } = botMemorySourceLink(source)
  const label = t('settings.bots.memorySource', 'From {{source}}', { source: text })
  if (!url) {
    return <span className="truncate">{label}</span>
  }
  return (
    <button
      type="button"
      className="inline-flex min-w-0 items-center gap-0.5 truncate rounded-sm hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={(event) => openAppHttpLink(url, { event })}
    >
      <span className="truncate">{label}</span>
      <ArrowUpRight className="size-2.5 shrink-0 opacity-75" />
    </button>
  )
}

/** Changes to MEMORY.md, made on the bot's host so each is one history row and no turn end undoes
 *  it. `fact` names a fact by its words as the list shows them. */
export type BotMemoryEdits = {
  add: (text: string) => Promise<void>
  reword: (fact: string, text: string) => Promise<void>
  forget: (fact: string) => Promise<void>
}

/** MEMORY.md one fact per row inside an inset card, with an always-ready Quick-Add composer on top. */
export function BotMemoryList({
  file,
  edits,
  onOpenAsFile
}: {
  file: Pick<BotHomeFile, 'refresh'> & { disk: string }
  edits: BotMemoryEdits
  onOpenAsFile?: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [quickAdd, setQuickAdd] = useState('')
  // An edit names its fact by content: the bot may move or remove lines while the owner types.
  const [editing, setEditing] = useState<BotMemoryFact | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const facts = parseBotMemoryFacts(file.disk)
  const lines = countBotMemoryLines(file.disk)
  const pct = Math.min(100, (lines / BOT_MEMORY_INDEX_LINE_CAP) * 100)
  // An edited fact the bot removed is saved as a new one, shown at the top of the list.
  const edited = editing ? findBotMemoryFact(file.disk, editing) : undefined
  const editorOnTop = editing !== null && edited === undefined

  // Applied by fact on the host, so a line the bot moved meanwhile is still the one edited; a
  // failure keeps the editor open with the draft.
  const run = async (change: () => Promise<void>): Promise<boolean> => {
    setSaving(true)
    try {
      await change()
      return true
    } catch (error) {
      toast.error(botErrorMessage(error))
      return false
    } finally {
      setSaving(false)
      await file.refresh()
    }
  }

  const openEdit = (fact: BotMemoryFact): void => {
    setEditing(fact)
    setDraft(fact.text)
  }

  const submitQuickAdd = async (): Promise<void> => {
    if (saving || quickAdd.trim() === '') {
      return
    }
    const submitted = quickAdd
    const text = submitted.trim()
    if (await run(() => edits.add(text))) {
      setQuickAdd((current) => (current === submitted ? '' : current))
    }
  }

  const submitEdit = async (): Promise<void> => {
    if (!editing || saving || draft.trim() === '') {
      return
    }
    const saved = await run(() => (edited ? edits.reword(edited.text, draft) : edits.add(draft)))
    if (saved) {
      setEditing(null)
    }
  }

  // Closing (Back, Escape, another bot) saves open drafts, as Soul's editor does.
  const unsavedEdit = editing !== null && !saving && draft.trim() !== '' && draft !== editing.text
  const unsavedQuickAdd = !saving && quickAdd.trim() !== ''
  useSaveOnClose(
    unsavedEdit || unsavedQuickAdd
      ? () => {
          if (unsavedEdit) {
            void (edited ? edits.reword(edited.text, draft) : edits.add(draft)).catch(
              (error: unknown) => toast.error(botErrorMessage(error))
            )
          }
          if (unsavedQuickAdd) {
            void edits
              .add(quickAdd.trim())
              .catch((error: unknown) => toast.error(botErrorMessage(error)))
          }
        }
      : null
  )

  const editor = (
    <div className="space-y-2 bg-background/80 p-2.5 dark:bg-input/40">
      <Textarea
        autoFocus
        aria-label={t('settings.bots.memoryFact', 'Memory')}
        value={draft}
        readOnly={saving}
        rows={2}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            void submitEdit()
          } else if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
            event.stopPropagation()
            setEditing(null)
          }
        }}
      />
      <div className="flex justify-end gap-1">
        <Button type="button" size="xs" variant="ghost" onClick={() => setEditing(null)}>
          {t('settings.bots.cancel', 'Cancel')}
        </Button>
        <Button
          type="button"
          size="xs"
          disabled={saving || draft.trim() === ''}
          onClick={() => void submitEdit()}
        >
          {t('settings.bots.save', 'Save')}
        </Button>
      </div>
    </div>
  )

  const openAsFileLabel = t('bots.settingsView.openAsFile', 'Open as file')
  const editLabel = t('settings.bots.editMemory', 'Edit')
  const forgetLabel = t('settings.bots.forget', 'Forget')

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex h-9 items-center gap-2 rounded-lg border border-border bg-background px-3 shadow-xs transition-colors focus-within:border-ring dark:bg-input/50">
        <Plus className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          type="text"
          aria-label={t('settings.bots.addMemory', 'Add memory')}
          placeholder={t('settings.bots.addMemoryPlaceholder', 'Remember something new…')}
          value={quickAdd}
          readOnly={saving}
          onChange={(event) => setQuickAdd(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void submitQuickAdd()
            } else if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
              if (quickAdd !== '') {
                event.preventDefault()
                event.stopPropagation()
                setQuickAdd('')
              }
              event.currentTarget.blur()
            }
          }}
          className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
        />
        {quickAdd.trim() ? (
          <Button type="button" size="xs" disabled={saving} onClick={() => void submitQuickAdd()}>
            {t('settings.bots.save', 'Save')}
          </Button>
        ) : null}
      </div>

      <SettingsInsetGroup
        title={
          <span className="inline-flex items-center gap-1">
            <span className="font-mono text-2xs">MEMORY.md</span>
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
                    <ExternalLink className="size-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={4}>
                  {openAsFileLabel}
                </TooltipContent>
              </Tooltip>
            ) : null}
          </span>
        }
        action={
          <div className="flex items-center gap-2 text-2xs text-muted-foreground">
            <span className="tabular-nums">
              {t('settings.bots.memoryLines', '{{count}} / {{cap}} lines', {
                count: lines,
                cap: BOT_MEMORY_INDEX_LINE_CAP
              })}
            </span>
            <div className="h-1 w-10 overflow-hidden rounded-full bg-foreground/10">
              <div
                className="h-full rounded-full bg-foreground/60 transition-[width]"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        }
      >
        {editorOnTop ? editor : null}
        {facts.length === 0 && !editorOnTop ? (
          <p className="px-3 py-3 text-xs text-muted-foreground">
            {t('settings.bots.memoryEmpty', 'No facts saved yet.')}
          </p>
        ) : null}
        {facts.map((fact) =>
          edited?.line === fact.line ? (
            <div key={fact.line}>{editor}</div>
          ) : (
            <div
              key={fact.line}
              className="group relative px-3 py-2 transition-colors hover:bg-accent/50"
            >
              <button
                type="button"
                className="block w-full text-left text-[13px] leading-[18.5px] text-foreground focus-visible:outline-none"
                onClick={() => openEdit(fact)}
              >
                {fact.text}
              </button>
              {fact.date || fact.source ? (
                <div className="mt-1 flex items-center gap-1.5 text-2xs text-muted-foreground">
                  {fact.date ? (
                    <span className="shrink-0 tabular-nums">{shortDate(fact.date)}</span>
                  ) : null}
                  {fact.date && fact.source ? <span aria-hidden>·</span> : null}
                  {fact.source ? <FactSource source={fact.source} /> : null}
                </div>
              ) : null}
              <div className="pointer-events-none absolute top-1.5 right-2 flex items-center gap-0.5 rounded-md bg-sidebar/90 pl-1.5 opacity-0 backdrop-blur-xs transition-opacity group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100">
                <Button
                  type="button"
                  variant="muted-field-icon"
                  size="icon-xs"
                  aria-label={editLabel}
                  title={editLabel}
                  onClick={() => openEdit(fact)}
                >
                  <Pencil className="size-3" />
                </Button>
                <Button
                  type="button"
                  variant="ghost-destructive"
                  size="icon-xs"
                  aria-label={forgetLabel}
                  title={forgetLabel}
                  onClick={() => void run(() => edits.forget(fact.text))}
                >
                  <Trash2 className="size-3" />
                </Button>
              </div>
            </div>
          )
        )}
      </SettingsInsetGroup>
    </div>
  )
}
