import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { useBots } from '@/lib/bot-catalog'
import { readBotHostListed } from '@/lib/bot-catalog-snapshot'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host/execution-host'
import { Input } from '../../../ui/input'
import type { AgentCopy } from '../../../../../../shared/agent-launch/catalog/agent-copies'
import { agentCopyIdPrefix, applyAgentCopyIdEdit, isAgentCopyIdSuffix } from './agent-copy-id-edit'

/** An agent copy's name and ID, at the top of its card; everything else is its agent's editors. */
export function AgentCopyIdentityFields({
  copy,
  taken,
  onRename,
  onChangeId
}: {
  copy: AgentCopy
  taken: readonly string[]
  onRename: (name: string) => Promise<void>
  onChangeId: (id: string) => Promise<void>
}): React.JSX.Element {
  const t = useTranslate()
  const [name, setName] = useState(copy.name)
  const prefix = agentCopyIdPrefix(copy.agent)
  const [suffix, setSuffix] = useState(copy.id.slice(prefix.length))
  const id = `${prefix}${suffix}`
  const idInputRef = useRef<HTMLInputElement>(null)
  const idShadowRef = useRef<HTMLDivElement>(null)
  // Where the caret goes after the latest edit. Each edit sets a new object, so an edit the field
  // rejects whole (Backspace into the prefix leaves the id as it was) still renders and places it,
  // and a placed caret is never placed again on a later render.
  const [caretAfterEdit, setCaretAfterEdit] = useState<{ at: number } | null>(null)
  // Where the selection started just before the edit the browser is making.
  const editStartRef = useRef<number | null>(null)
  // The greyed prefix is drawn by a copy of the text behind the input, scrolled with it.
  const syncIdShadow = (): void => {
    if (idShadowRef.current && idInputRef.current) {
      idShadowRef.current.scrollLeft = idInputRef.current.scrollLeft
    }
  }
  useLayoutEffect(() => {
    const input = idInputRef.current
    const at = caretAfterEdit?.at
    // Moving a caret that is already in place would disturb an IME composition for nothing.
    if (input && at !== undefined && (input.selectionStart !== at || input.selectionEnd !== at)) {
      input.setSelectionRange(at, at)
    }
  }, [caretAfterEdit])
  useLayoutEffect(syncIdShadow)
  useEffect(() => {
    const input = idInputRef.current
    if (!input) {
      return
    }
    const onBeforeInput = (event: InputEvent): void => {
      // A drop inserts where the pointer is, not at the selection.
      editStartRef.current = event.inputType === 'insertFromDrop' ? null : input.selectionStart
    }
    input.addEventListener('beforeinput', onBeforeInput)
    return () => input.removeEventListener('beforeinput', onBeforeInput)
  }, [])
  // A bot runs as its copy by id, so the id stays put while one does.
  const boundBots = useBots()
    .filter((bot) => bot.agentCopy === copy.id)
    .map((bot) => bot.name)
  // Until this computer's bot list has been read, an empty list proves nothing.
  const botsListed = readBotHostListed(LOCAL_EXECUTION_HOST_ID)
  const idProblem =
    id !== copy.id && !botsListed
      ? t(
          'settings.agents.copyIdBotsUnknown',
          "Orca hasn't read this computer's bots yet, so the ID can't change until it has."
        )
      : id !== copy.id && boundBots.length > 0
        ? t('settings.agents.copyIdInUse', 'Used by {{bots}}. Change what they run as first.', {
            bots: boundBots.join(', ')
          })
        : !isAgentCopyIdSuffix(copy.agent, suffix)
          ? t('settings.agents.copyIdInvalid', 'Use lowercase letters, digits and dashes.')
          : taken.includes(id)
            ? t('settings.agents.copyIdTaken', 'Another copy has this ID.')
            : null
  const commitName = (): void => {
    const trimmed = name.trim()
    if (!trimmed) {
      setName(copy.name)
    } else if (trimmed !== copy.name) {
      // A failed save keeps the draft for another try; the save itself reports the failure.
      onRename(trimmed).catch(() => {})
    }
  }
  const commitId = (): void => {
    if (!idProblem && id !== copy.id) {
      onChangeId(id).catch(() => {})
    }
  }
  return (
    <div className="flex flex-wrap gap-3">
      <label className="flex min-w-48 flex-1 flex-col gap-1">
        <span className="text-xs text-muted-foreground">
          {t('settings.agents.copyName', 'Copy name')}
        </span>
        <Input
          value={name}
          aria-label={t('settings.agents.copyName', 'Copy name')}
          className="h-8"
          onChange={(event) => setName(event.target.value)}
          onBlur={commitName}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.currentTarget.blur()
            }
            if (event.key === 'Escape') {
              setName(copy.name)
            }
          }}
        />
      </label>
      <label className="flex min-w-48 flex-1 flex-col gap-1">
        <span className="text-xs text-muted-foreground">{t('settings.agents.copyId', 'ID')}</span>
        {/* One input holds the whole id, so it selects and copies as one string; the prefix
            stays put and shows greyed through the transparent text. */}
        <div className="relative">
          <div
            ref={idShadowRef}
            aria-hidden="true"
            data-agent-copy-id-shadow=""
            className="pointer-events-none absolute inset-0 flex items-center overflow-hidden whitespace-pre rounded-md border border-transparent px-3 font-mono text-xs"
          >
            <span className="text-muted-foreground">{prefix}</span>
            <span className="text-foreground">{suffix}</span>
          </div>
          <Input
            ref={idInputRef}
            value={id}
            aria-label={t('settings.agents.copyIdLabel', 'Copy ID')}
            aria-invalid={idProblem !== null}
            variant="code"
            surface="underlay"
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            className="relative h-8"
            onChange={(event) => {
              const field = event.currentTarget
              const edit = applyAgentCopyIdEdit(
                prefix,
                id,
                field.value,
                field.selectionEnd,
                editStartRef.current
              )
              editStartRef.current = null
              // Write a rewritten id straight back, so nothing rewrites the field again after the
              // caret is placed: React restores a controlled value whose state did not change
              // after its effects run, which sends the caret to the end.
              const value = `${prefix}${edit.suffix}`
              if (field.value !== value) {
                field.value = value
              }
              setSuffix(edit.suffix)
              setCaretAfterEdit({ at: edit.caret })
            }}
            onCompositionStart={(event) => {
              // An IME composes in place, so start it after the prefix rather than inside it.
              const field = event.currentTarget
              const start = field.selectionStart ?? prefix.length
              if (start < prefix.length) {
                const end = Math.max(field.selectionEnd ?? start, prefix.length)
                field.setSelectionRange(prefix.length, end)
              }
            }}
            onScroll={syncIdShadow}
            onSelect={syncIdShadow}
            onDoubleClick={(event) => event.currentTarget.select()}
            onBlur={commitId}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.currentTarget.blur()
              }
              if (event.key === 'Escape') {
                setSuffix(copy.id.slice(prefix.length))
              }
            }}
          />
        </div>
        {idProblem && <p className="text-[11px] text-destructive">{idProblem}</p>}
      </label>
    </div>
  )
}
