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
  onSaveArgs
}: {
  defaultArgs: string
  argsOverride: string
  onSaveArgs: (value: string) => void | Promise<void>
}): React.JSX.Element {
  const [argsDraft, setArgsDraft] = useState(argsOverride)
  const { pending, write } = useAgentLaunchFieldWrite()
  const commitArgs = (): void => {
    const value = argsDraft.trim()
    write(value, () => onSaveArgs(value))
  }

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">
        {translate('auto.components.settings.AgentsPane.cfb3f35775', 'Arguments')}
      </span>
      <div className="flex items-center gap-2">
        <Input
          value={argsDraft}
          readOnly={pending}
          onChange={(event) => setArgsDraft(event.target.value)}
          onBlur={commitArgs}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              commitArgs()
              event.currentTarget.blur()
            }
            if (event.key === 'Escape') {
              setArgsDraft(argsOverride)
              event.currentTarget.blur()
            }
          }}
          placeholder={
            defaultArgs ||
            translate('auto.components.settings.AgentsPane.6f99bf5dd0', 'No default arguments')
          }
          spellCheck={false}
          className="h-7 flex-1 font-mono text-xs"
        />
        {argsOverride !== defaultArgs && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => {
              write(
                defaultArgs,
                () => onSaveArgs(defaultArgs),
                () => setArgsDraft(defaultArgs)
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

export function AgentDefaultEnvInput({
  defaultEnv,
  envOverride,
  onSaveEnv
}: {
  defaultEnv: Record<string, string>
  envOverride: Record<string, string>
  onSaveEnv: (value: Record<string, string>) => void
}): React.JSX.Element {
  const defaultEnvText = stringifyAgentDefaultEnvDraft(defaultEnv)
  const draftSeed = stringifyAgentDefaultEnvDraft(envOverride)
  const [envDraft, setEnvDraft] = useState(draftSeed)
  const [envDraftError, setEnvDraftError] = useState<AgentDefaultEnvDraftInvalidReason | null>(null)
  const envDraftErrorId = useId()
  const commitEnv = (): void => {
    if (envDraft === draftSeed) {
      return
    }
    const parsedDraft = parseAgentDefaultEnvDraft(envDraft)
    setEnvDraftError(parsedDraft.invalidReason)
    if (!parsedDraft.invalidReason) {
      onSaveEnv(parsedDraft.env)
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">
        {translate('auto.components.settings.AgentsPane.8fbe1f37c1', 'Environment')}
      </span>
      <div className="flex items-center gap-2">
        <Input
          value={envDraft}
          onChange={(event) => {
            setEnvDraft(event.target.value)
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
              setEnvDraft(draftSeed)
              setEnvDraftError(null)
              event.currentTarget.blur()
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
        {draftSeed !== defaultEnvText && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => {
              onSaveEnv(defaultEnv)
              setEnvDraft(defaultEnvText)
              setEnvDraftError(null)
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
