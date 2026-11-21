import { useLayoutEffect, useRef, useState } from 'react'
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
  // Where the caret goes after an edit the field rewrote, such as one that reached into the prefix.
  const pendingCaretRef = useRef<number | null>(null)
  // The greyed prefix is drawn by a copy of the text behind the input, scrolled with it.
  const syncIdShadow = (): void => {
    if (idShadowRef.current && idInputRef.current) {
      idShadowRef.current.scrollLeft = idInputRef.current.scrollLeft
    }
  }
  useLayoutEffect(() => {
    const input = idInputRef.current
    if (input && pendingCaretRef.current !== null) {
      input.setSelectionRange(pendingCaretRef.current, pendingCaretRef.current)
      pendingCaretRef.current = null
    }
    syncIdShadow()
  })
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
              const edit = applyAgentCopyIdEdit(prefix, id, field.value, field.selectionEnd)
              if (`${prefix}${edit.suffix}` !== field.value) {
                pendingCaretRef.current = edit.caret
              }
              setSuffix(edit.suffix)
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
