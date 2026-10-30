import { useId, useLayoutEffect, useRef, useState } from 'react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Textarea } from '../ui/textarea'
import { translate } from '@/i18n/i18n'
import {
  parseAgentDefaultEnvDraft,
  stringifyAgentDefaultEnvDraft,
  type AgentDefaultEnvDraftInvalidReason
} from './agent-default-env-draft'
import { useAgentLaunchFieldWrite } from './use-agent-launch-field-write'
import { AgentArgsChoiceChips, type AgentArgsChoice } from './AgentPermissionChoiceControls'

export function AgentCommandOverrideInput({
  defaultCmd,
  cmdOverride,
  onSaveOverride
}: {
  defaultCmd: string
  cmdOverride: string | undefined
  onSaveOverride: (value: string) => void | Promise<void>
}): React.JSX.Element {
  const draftSeed = cmdOverride ?? defaultCmd
  const [cmdDraft, setCmdDraft] = useState(draftSeed)
  const { pending, write } = useAgentLaunchFieldWrite()
  const commitCmd = (): void => {
    const trimmed = cmdDraft.trim()
    if (!trimmed || trimmed === defaultCmd) {
      write(
        '',
        () => onSaveOverride(''),
        () => setCmdDraft(defaultCmd)
      )
    } else {
      write(trimmed, () => onSaveOverride(trimmed))
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">
        {translate('auto.components.settings.AgentsPane.2e45ca29b6', 'Command')}
      </span>
      <div className="flex items-center gap-2">
        <Input
          value={cmdDraft}
          readOnly={pending}
          onChange={(event) => setCmdDraft(event.target.value)}
          onBlur={commitCmd}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              commitCmd()
              event.currentTarget.blur()
            }
            if (event.key === 'Escape') {
              setCmdDraft(draftSeed)
              event.currentTarget.blur()
            }
          }}
          placeholder={defaultCmd}
          spellCheck={false}
          className="h-7 flex-1 font-mono text-xs"
        />
        {cmdOverride && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => {
              write(
                '',
                () => onSaveOverride(''),
                () => setCmdDraft(defaultCmd)
              )
            }}
            className="h-7 shrink-0 text-xs text-muted-foreground hover:text-foreground"
          >
            {translate('auto.components.settings.AgentsPane.5200dac9da', 'Reset')}
          </Button>
        )}
      </div>
    </div>
  )
}

export function AgentDefaultArgsInput({
  defaultArgs,
  argsOverride,
  onSaveArgs,
  choiceChips,
  note,
  disabled = false,
  onDraftChange,
  placeholder,
  onResetArgs
}: {
  defaultArgs: string
  placeholder?: string
  onResetArgs?: () => void | Promise<void>
  argsOverride: string
  onSaveArgs: (value: string) => void | Promise<void>
  choiceChips?: readonly AgentArgsChoice[]
  note?: string
  disabled?: boolean
  onDraftChange?: (value: string) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const chipRef = useRef<HTMLSpanElement>(null)
  const chipButtonRef = useRef<HTMLButtonElement>(null)
  const argsDraft = onDraftChange ? argsOverride : (draft ?? argsOverride)
  const { pending, write } = useAgentLaunchFieldWrite()
  const chipFlags = choiceChips?.map((chip) => chip.flag).join(' ')
  useLayoutEffect(() => {
    const input = inputRef.current
    const chip = chipRef.current
    if (!input) {
      return
    }
    input.style.textIndent = ''
    if (!chip) {
      return
    }
    const measure = (): void => {
      input.style.textIndent = `calc(${chip.getBoundingClientRect().width}px + var(--spacing) * 2)`
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(chip)
    return () => observer.disconnect()
  }, [chipFlags])
  const commitArgs = (): void => {
    if (disabled || pending || (!onDraftChange && draft === null)) {
      return
    }
    const value = argsDraft.trim()
    if (!onDraftChange && value === argsOverride) {
      setDraft(null)
      return
    }
    write(
      value,
      () => onSaveArgs(value),
      () => setDraft((current) => (current === draft ? null : current))
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs font-medium leading-none text-muted-foreground">
        {translate('auto.components.settings.AgentsPane.cfb3f35775', 'Arguments')}
      </span>
      <div className="flex min-w-0 items-center gap-2">
        <div
          className="scrollbar-sleek relative max-h-[calc(var(--spacing)*41+2px)] min-h-7 min-w-0 flex-1 overflow-x-hidden overflow-y-auto rounded-md border border-input px-3 py-0.5 shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30"
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) {
              commitArgs()
            }
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              inputRef.current?.focus()
            }
          }}
        >
          {choiceChips?.length ? (
            <AgentArgsChoiceChips
              chips={choiceChips}
              chipRef={chipRef}
              buttonRef={chipButtonRef}
              disabled={disabled || pending}
              onRemove={(chip) => {
                if (disabled || pending) {
                  return
                }
                const next = chip.onRemove(argsDraft)
                if (!onDraftChange && draft !== null) {
                  setDraft(next)
                }
                inputRef.current?.focus()
              }}
            />
          ) : null}
          <Textarea
            variant="composite"
            ref={inputRef}
            rows={1}
            value={argsDraft}
            disabled={disabled}
            readOnly={pending}
            aria-label={translate('auto.components.settings.AgentsPane.cfb3f35775', 'Arguments')}
            onChange={(event) =>
              (onDraftChange ?? setDraft)(event.target.value.replace(/[\r\n]/g, ''))
            }
            onKeyDown={(event) => {
              if (disabled || pending) {
                return
              }
              if (
                choiceChips?.length &&
                event.key === 'Backspace' &&
                !event.repeat &&
                !event.altKey &&
                !event.ctrlKey &&
                !event.metaKey &&
                event.currentTarget.selectionStart === 0 &&
                event.currentTarget.selectionEnd === 0
              ) {
                event.preventDefault()
                chipButtonRef.current?.focus()
              }
              if (event.key === 'Enter') {
                event.preventDefault()
                commitArgs()
                event.currentTarget.blur()
              }
              if (event.key === 'Escape') {
                setDraft(null)
              }
            }}
            placeholder={
              choiceChips?.length
                ? undefined
                : placeholder ||
                  defaultArgs ||
                  translate(
                    'auto.components.settings.AgentsPane.6f99bf5dd0',
                    'No default arguments'
                  )
            }
            spellCheck={false}
            className="block min-h-5 [field-sizing:content]"
          />
        </div>
        {(argsOverride !== defaultArgs ||
          argsDraft !== defaultArgs ||
          Boolean(onResetArgs && choiceChips?.length)) && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={disabled}
            onClick={() => {
              if (!onDraftChange) {
                setDraft(argsDraft)
              }
              write(
                defaultArgs,
                () => (onResetArgs ? onResetArgs() : onSaveArgs(defaultArgs)),
                () => setDraft((current) => (current === argsDraft ? null : current))
              )
            }}
            className="h-7 shrink-0 text-xs text-muted-foreground hover:text-foreground"
          >
            {translate('auto.components.settings.AgentsPane.5200dac9da', 'Reset')}
          </Button>
        )}
      </div>
      {note ? <p className="text-[11px] text-muted-foreground">{note}</p> : null}
    </div>
  )
}

export function AgentDefaultEnvInput({
  showEmpty = false,
  defaultEnv,
  envOverride,
  onSaveEnv
}: {
  showEmpty?: boolean
  defaultEnv: Record<string, string>
  envOverride: Record<string, string>
  onSaveEnv: (value: Record<string, string>) => void | Promise<void>
}): React.JSX.Element | null {
  const defaultEnvText = stringifyAgentDefaultEnvDraft(defaultEnv)
  const draftSeed = stringifyAgentDefaultEnvDraft(envOverride)
  const [draft, setDraft] = useState<string | null>(null)
  const envDraft = draft ?? draftSeed
  const { pending, write } = useAgentLaunchFieldWrite()
  const [envDraftError, setEnvDraftError] = useState<AgentDefaultEnvDraftInvalidReason | null>(null)
  const envDraftErrorId = useId()
  const commitEnv = (): void => {
    if (pending || draft === null) {
      return
    }
    if (envDraft === draftSeed) {
      setDraft(null)
      return
    }
    const parsedDraft = parseAgentDefaultEnvDraft(envDraft)
    setEnvDraftError(parsedDraft.invalidReason)
    if (!parsedDraft.invalidReason) {
      setDraft(envDraft)
      write(
        stringifyAgentDefaultEnvDraft(parsedDraft.env),
        () => onSaveEnv(parsedDraft.env),
        () => setDraft((current) => (current === envDraft ? null : current))
      )
    }
  }

  if (!showEmpty && !defaultEnvText && !draftSeed && draft === null && !pending) {
    return null
  }
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">
        {translate('auto.components.settings.AgentsPane.8fbe1f37c1', 'Environment')}
      </span>
      <div className="flex items-center gap-2">
        <Input
          value={envDraft}
          readOnly={pending}
          onChange={(event) => {
            setDraft(event.target.value)
            if (envDraftError) {
              setEnvDraftError(null)
            }
          }}
          onBlur={commitEnv}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              commitEnv()
              event.currentTarget.blur()
            }
            if (event.key === 'Escape') {
              setDraft(null)
              setEnvDraftError(null)
            }
          }}
          placeholder={
            defaultEnvText ||
            translate('auto.components.settings.AgentsPane.2d133152fa', 'No default environment')
          }
          spellCheck={false}
          aria-invalid={envDraftError ? true : undefined}
          aria-describedby={envDraftError ? envDraftErrorId : undefined}
          className="h-7 flex-1 font-mono text-xs"
        />
        {(draftSeed !== defaultEnvText || envDraft !== defaultEnvText) && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => {
              setDraft(envDraft)
              write(
                defaultEnvText,
                () => onSaveEnv(defaultEnv),
                () => {
                  setDraft((current) => (current === envDraft ? null : current))
                  setEnvDraftError(null)
                }
              )
            }}
            className="h-7 shrink-0 text-xs text-muted-foreground hover:text-foreground"
          >
            {translate('auto.components.settings.AgentsPane.5200dac9da', 'Reset')}
          </Button>
        )}
      </div>
      {envDraftError && (
        <p id={envDraftErrorId} className="mt-1 text-[11px] text-destructive">
          {envDraftError === 'too-large'
            ? translate(
                'auto.components.settings.AgentsPane.3f1bdf3cb4',
                'Environment text is too large to parse safely.'
              )
            : translate(
                'settings.agents.environmentUnclosedQuote',
                'Close the quote to save the environment.'
              )}
        </p>
      )}
    </div>
  )
}
