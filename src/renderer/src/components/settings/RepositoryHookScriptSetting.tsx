import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Plus } from 'lucide-react'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip'
import { translate } from '@/i18n/i18n'
import { getRepositoryHookScriptTextareaRows } from '@/lib/script-textarea-rows'
import type {
  LocalCommandSourcePolicyNotice,
  LocalHookField
} from './repository-hook-settings-draft'

function getEnvVars(): { name: string; description: string }[] {
  return [
    {
      name: '$ORCA_ROOT_PATH',
      description: translate(
        'auto.components.settings.RepositoryHooksSection.30952c4aa4',
        'Path to the main repo checkout. Useful for copying shared files, like .env, into a worktree.'
      )
    },
    {
      name: '$ORCA_WORKTREE_PATH',
      description: translate(
        'auto.components.settings.RepositoryHooksSection.54c73d88d0',
        'Path to the worktree being created. Setup commands run from this directory.'
      )
    },
    {
      name: '$ORCA_WORKSPACE_NAME',
      description: translate(
        'auto.components.settings.RepositoryHooksSection.0fa21e19ec',
        'Name of the workspace, usually based on the branch name.'
      )
    }
  ]
}

function EnvVarChips(): React.JSX.Element {
  const envVars = getEnvVars()
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] text-muted-foreground">
        {translate(
          'auto.components.settings.RepositoryHooksSection.b2b06c7ce8',
          'Available environment variables (hover for details):'
        )}
      </p>
      <TooltipProvider delayDuration={150}>
        <div className="flex flex-wrap gap-1.5">
          {envVars.map(({ name, description }) => (
            <Tooltip key={name}>
              <TooltipTrigger asChild>
                <code
                  tabIndex={0}
                  className="cursor-help rounded-md border border-border/50 bg-muted/35 px-2 py-1 font-mono text-[11px] text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {name}
                </code>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6} className="max-w-80 text-left text-wrap">
                {description}
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
      </TooltipProvider>
    </div>
  )
}

function SaveIndicator({ status }: { status: 'idle' | 'saving' | 'saved' }) {
  if (status === 'idle') {
    return null
  }
  const isSaving = status === 'saving'
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"
      aria-live="polite"
    >
      <span
        className={`size-1.5 rounded-full ${isSaving ? 'animate-pulse bg-amber-500' : 'bg-emerald-500'}`}
      />
      {isSaving
        ? translate('auto.components.settings.RepositoryHooksSection.81057d5f71', 'Saving...')
        : translate('auto.components.settings.RepositoryHooksSection.2b6356e744', 'Saved')}
    </span>
  )
}

export function RepositoryHookScriptSetting({
  field,
  value,
  hasShared,
  sharedScript,
  onChange,
  onCommit,
  sectionId
}: {
  field: LocalHookField
  value: string
  hasShared: boolean
  sharedScript: string | undefined
  onChange: (next: string) => void
  onCommit: () => void
  sectionId?: string
}): React.JSX.Element {
  const [showLocal, setShowLocal] = useState(value.length > 0)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  const lastValueRef = useRef(value)
  const savedTimerRef = useRef<number | null>(null)
  useEffect(() => {
    if (value === lastValueRef.current) {
      return
    }
    lastValueRef.current = value
    setSaveStatus('saving')
    if (savedTimerRef.current !== null) {
      window.clearTimeout(savedTimerRef.current)
    }
    savedTimerRef.current = window.setTimeout(() => {
      setSaveStatus('saved')
      savedTimerRef.current = window.setTimeout(() => {
        setSaveStatus('idle')
        savedTimerRef.current = null
      }, 1500)
    }, 250)
    return () => {
      if (savedTimerRef.current !== null) {
        window.clearTimeout(savedTimerRef.current)
        savedTimerRef.current = null
      }
    }
  }, [value])

  const showLocalEditor = showLocal || value.length > 0 || !hasShared
  return (
    <div
      className="space-y-3 rounded-2xl border border-border/50 bg-background/80 p-4 shadow-sm"
      id={sectionId}
    >
      <div className="space-y-1">
        <h5 className="text-sm font-semibold">{field.label}</h5>
        <p className="text-xs text-muted-foreground">{field.description}</p>
      </div>
      <EnvVarChips />
      {hasShared ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
              {translate('auto.components.settings.RepositoryHooksSection.39da2ae12f', 'orca.yaml')}
              <span className="font-normal text-emerald-700/80 dark:text-emerald-300/80">
                {translate(
                  'auto.components.settings.RepositoryHooksSection.f828e1de19',
                  '- shared with your team'
                )}
              </span>
            </span>
            <span className="text-[11px] text-muted-foreground">
              {translate('auto.components.settings.RepositoryHooksSection.b113344b6a', 'Edit')}{' '}
              <code className="rounded bg-muted px-1 py-0.5">
                {translate(
                  'auto.components.settings.RepositoryHooksSection.39da2ae12f',
                  'orca.yaml'
                )}
              </code>{' '}
              {translate(
                'auto.components.settings.RepositoryHooksSection.7e4427b4a2',
                'to change.'
              )}
            </span>
          </div>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-border/50 bg-muted/30 p-3 font-mono text-[11.5px] leading-5 text-foreground">
            {sharedScript ?? ''}
          </pre>
        </div>
      ) : null}
      {showLocalEditor ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            {hasShared ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/30 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                {translate('auto.components.settings.RepositoryHooksSection.2d03a514db', 'local')}
                <span className="font-normal">
                  {translate(
                    'auto.components.settings.RepositoryHooksSection.40a446ae16',
                    '- just for you, on this machine'
                  )}
                </span>
              </span>
            ) : (
              <span />
            )}
            <SaveIndicator status={saveStatus} />
          </div>
          <textarea
            value={value}
            aria-label={field.label}
            onChange={(event) => onChange(event.target.value)}
            onBlur={onCommit}
            placeholder={field.placeholder}
            spellCheck={false}
            rows={getRepositoryHookScriptTextareaRows(value)}
            className="w-full min-w-0 resize-y rounded-lg border border-input bg-muted/20 px-3 py-2 font-mono text-[12px] leading-[1.55] shadow-xs transition-[color,box-shadow] outline-none placeholder:italic placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:bg-background focus-visible:ring-[3px] focus-visible:ring-ring/40"
          />
          <p className="text-[11px] text-muted-foreground">
            {translate(
              'auto.components.settings.RepositoryHooksSection.8c2893fae0',
              'Runs as a single shell script. Saved on this machine.'
            )}
          </p>
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setShowLocal(true)}
          className="gap-1.5"
        >
          <Plus className="size-3.5" />
          {translate(
            'auto.components.settings.RepositoryHooksSection.5d940bde5c',
            'Add local script'
          )}
        </Button>
      )}
    </div>
  )
}

export function LocalCommandSourceNotice({
  notice,
  onSelectPolicy
}: {
  notice: LocalCommandSourcePolicyNotice
  onSelectPolicy: (policy: 'local-only' | 'run-both') => void
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-amber-500/20 bg-amber-500/5 p-3">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-300" />
        <div className="space-y-1">
          <p className="text-sm font-medium text-amber-700 dark:text-amber-300">
            {translate(
              'auto.components.settings.RepositoryHooksSection.5426ecbdcb',
              'Local scripts will not run'
            )}
          </p>
          <p className="text-xs leading-5 text-muted-foreground">
            {notice.kind === 'checking'
              ? translate(
                  'auto.components.settings.RepositoryHooksSection.7f78e5eea6',
                  'Local scripts are saved. Orca is still checking orca.yaml before it can recommend which script source to use.'
                )
              : translate(
                  'auto.components.settings.RepositoryHooksSection.0ce113fd7b',
                  'Local scripts are saved, but Script Source is set to orca.yaml only.'
                )}
          </p>
        </div>
      </div>
      {notice.kind === 'action' ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => onSelectPolicy(notice.policy)}
        >
          {notice.label}
        </Button>
      ) : (
        <span className="shrink-0 rounded-full border border-border/60 bg-muted/30 px-2 py-1 text-[11px] text-muted-foreground">
          {translate('auto.components.settings.RepositoryHooksSection.673a7fd10e', 'Checking...')}
        </span>
      )}
    </div>
  )
}
