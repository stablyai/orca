import { useState } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Textarea } from '@/components/ui/textarea'
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

// An edit names its fact by content: the bot may move or remove lines while the owner types.
type Editing = { kind: 'edit'; fact: BotMemoryFact } | { kind: 'add' }

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
  return (
    <span className="block truncate text-xs text-muted-foreground">
      {t('settings.bots.memorySource', 'From {{source}}', { source: text })}
      {url ? (
        <>
          {' · '}
          <button
            type="button"
            className="rounded-sm underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={(event) => openAppHttpLink(url, { event })}
          >
            {t('settings.bots.memorySourceLink', 'link')}
          </button>
        </>
      ) : null}
    </span>
  )
}

/** Changes to MEMORY.md, made on the bot's host so each is one history row and no turn end undoes
 *  it. `fact` names a fact by its words as the list shows them. */
export type BotMemoryEdits = {
  add: (text: string) => Promise<void>
  reword: (fact: string, text: string) => Promise<void>
  forget: (fact: string) => Promise<void>
}

/** MEMORY.md one fact per row: click to edit, hover to forget, and add new facts on top. */
export function BotMemoryList({
  file,
  edits
}: {
  file: Pick<BotHomeFile, 'refresh'> & { disk: string }
  edits: BotMemoryEdits
}): React.JSX.Element {
  const t = useTranslate()
  const [editing, setEditing] = useState<Editing | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const facts = parseBotMemoryFacts(file.disk)
  const lines = countBotMemoryLines(file.disk)
  // An edited fact the bot removed is saved as a new one, shown where new ones go.
  const edited = editing?.kind === 'edit' ? findBotMemoryFact(file.disk, editing.fact) : undefined
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

  const open = (next: Editing): void => {
    setEditing(next)
    setDraft(next.kind === 'edit' ? next.fact.text : '')
  }

  const submit = async (): Promise<void> => {
    if (!editing || saving || draft.trim() === '') {
      return
    }
    const saved = await run(() => (edited ? edits.reword(edited.text, draft) : edits.add(draft)))
    if (saved) {
      setEditing(null)
    }
  }

  // Closing (Back, Escape, another bot) saves an open draft, as Soul's editor does.
  const unsaved =
    editing !== null &&
    !saving &&
    draft.trim() !== '' &&
    draft !== (editing.kind === 'edit' ? editing.fact.text : '')
  useSaveOnClose(
    unsaved
      ? () =>
          void (edited ? edits.reword(edited.text, draft) : edits.add(draft)).catch(
            (error: unknown) => toast.error(botErrorMessage(error))
          )
      : null
  )

  const editor = (
    <div className="space-y-2 rounded-md border border-border p-2">
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
            void submit()
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
          onClick={() => void submit()}
        >
          {t('settings.bots.save', 'Save')}
        </Button>
      </div>
    </div>
  )

  return (
    <div className="space-y-2">
      <div className="space-y-1.5 px-1">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span className="font-mono">MEMORY.md</span>
          <span>
            {t('settings.bots.memoryLines', '{{count}} / {{cap}} lines', {
              count: lines,
              cap: BOT_MEMORY_INDEX_LINE_CAP
            })}
          </span>
        </div>
        <Progress
          value={Math.min(100, (lines / BOT_MEMORY_INDEX_LINE_CAP) * 100)}
          className="h-1"
        />
      </div>
      <ul className="space-y-0.5">
        {editorOnTop ? <li>{editor}</li> : null}
        {facts.map((fact) =>
          edited?.line === fact.line ? (
            <li key={fact.line}>{editor}</li>
          ) : (
            <li
              key={fact.line}
              className="group flex items-center gap-3 rounded-md px-2 hover:bg-accent"
            >
              <div className="min-w-0 flex-1 py-1.5">
                <button
                  type="button"
                  className="w-full text-left text-sm"
                  onClick={() => open({ kind: 'edit', fact })}
                >
                  {fact.text}
                </button>
                {fact.source ? <FactSource source={fact.source} /> : null}
              </div>
              {fact.date ? (
                <span className="shrink-0 text-xs text-muted-foreground group-focus-within:hidden group-hover:hidden">
                  {shortDate(fact.date)}
                </span>
              ) : null}
              <Button
                type="button"
                size="xs"
                variant="ghost"
                className="hidden group-focus-within:inline-flex group-hover:inline-flex"
                onClick={() => void run(() => edits.forget(fact.text))}
              >
                {t('settings.bots.forget', 'Forget')}
              </Button>
            </li>
          )
        )}
      </ul>
      {editorOnTop ? null : (
        <Button type="button" size="xs" variant="ghost" onClick={() => open({ kind: 'add' })}>
          <Plus />
          {t('settings.bots.addMemory', 'Add memory')}
        </Button>
      )}
    </div>
  )
}
