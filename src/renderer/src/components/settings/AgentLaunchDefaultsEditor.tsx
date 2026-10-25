import { useId, useState } from 'react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { translate } from '@/i18n/i18n'
import {
  parseAgentDefaultEnvDraft,
  stringifyAgentDefaultEnvDraft,
  type AgentDefaultEnvDraftInvalidReason
} from './agent-default-env-draft'
import { useAgentLaunchFieldWrite } from './use-agent-launch-field-write'

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
  permissionChip,
  note
}: {
  defaultArgs: string
  argsOverride: string
  onSaveArgs: (value: string) => void | Promise<void>
  /** The permission flag terminals add ahead of the text, drawn just before the box. */
  permissionChip?: React.ReactNode
  note?: string
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const argsDraft = draft ?? argsOverride
  const { pending, write } = useAgentLaunchFieldWrite()
  const commitArgs = (): void => {
    if (pending || draft === null) {
      return
    }
    const value = draft.trim()
    if (value === argsOverride) {
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
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">
        {translate('auto.components.settings.AgentsPane.cfb3f35775', 'Arguments')}
      </span>
      <div className="flex items-center gap-2">
        {permissionChip}
        <Input
          value={argsDraft}
          readOnly={pending}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitArgs}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              commitArgs()
              event.currentTarget.blur()
            }
            if (event.key === 'Escape') {
              setDraft(null)
            }
          }}
          placeholder={
            defaultArgs ||
            translate('auto.components.settings.AgentsPane.6f99bf5dd0', 'No default arguments')
          }
          spellCheck={false}
          className="h-7 flex-1 font-mono text-xs"
        />
        {(argsOverride !== defaultArgs || argsDraft !== defaultArgs) && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => {
              setDraft(argsDraft)
              write(
                defaultArgs,
                () => onSaveArgs(defaultArgs),
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
