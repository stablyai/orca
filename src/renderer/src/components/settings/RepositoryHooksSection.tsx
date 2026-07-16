/* eslint-disable max-lines -- Why: the script editor, advanced/Command Source disclosure, issue-command override, and YAML state surfaces share tightly coupled state and persistence; splitting them across files would scatter prop drilling. */
/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: repository hook saves and issue-command overrides synchronize debounced persistence state with external repo settings. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  HookCommandSourcePolicy,
  OrcaHooks,
  Repo,
  RepoHookSettings,
  SetupAgentStartupPolicy,
  SetupRunPolicy
} from '../../../../shared/types'
import { AlertTriangle, ChevronRight, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitch } from './SettingsFormControls'
import { useAppStore } from '@/store'
import { readRuntimeIssueCommand, writeRuntimeIssueCommand } from '@/runtime/runtime-hooks-client'
import { DEFAULT_REPO_HOOK_SETTINGS } from './SettingsConstants'
import { resolveHookCommandSourcePolicy } from '../../../../shared/hook-command-source-policy'
import { getRepositoryLocalCommandsSectionId } from './repository-settings-targets'
import { matchesSettingsSearch } from './settings-search'
import { translate } from '@/i18n/i18n'
import { getRepositoryHookScriptTextareaRows } from '@/lib/script-textarea-rows'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'

type RepositoryHooksSectionProps = {
  repo: Repo
  yamlHooks: OrcaHooks | null
  hasHooksFile: boolean
  hooksInspectionReady: boolean
  mayNeedUpdate: boolean
  copiedTemplate: boolean
  forceVisible?: boolean
  onCopyTemplate: () => void
  onUpdateHookSettings: (settings: RepoHookSettings) => void
}

type PolicyOption<P> = { policy: P; label: string; description: string }
const LOCAL_HOOK_NAMES = ['setup', 'archive'] as const
type LocalHookName = (typeof LOCAL_HOOK_NAMES)[number]
type HookSettingsPolicyDraft = Partial<
  Pick<RepoHookSettings, 'setupRunPolicy' | 'setupAgentStartupPolicy' | 'commandSourcePolicy'>
>

// Why: this is a literal issue-command template token, not app data for i18next to fill.
const ARTIFACT_URL_TEMPLATE_TOKEN = '{{artifact_url}}'

type LocalHookField = {
  name: LocalHookName
  label: string
  description: string
  placeholder: string
}

const EXAMPLE_TEMPLATE = `scripts:
  setup: |
    pnpm worktree:setup
  archive: |
    echo "Cleaning up before archive"
issueCommand: |
  Complete {{artifact_url}}`

function getHookSettingsDraft(hookSettings: Repo['hookSettings']): RepoHookSettings {
  return {
    ...DEFAULT_REPO_HOOK_SETTINGS,
    ...hookSettings,
    scripts: {
      ...DEFAULT_REPO_HOOK_SETTINGS.scripts,
      ...hookSettings?.scripts
    }
  }
}

function areHookSettingsDraftsEqual(a: RepoHookSettings, b: RepoHookSettings): boolean {
  return (
    a.mode === b.mode &&
    a.setupRunPolicy === b.setupRunPolicy &&
    a.setupAgentStartupPolicy === b.setupAgentStartupPolicy &&
    a.commandSourcePolicy === b.commandSourcePolicy &&
    a.scripts.setup === b.scripts.setup &&
    a.scripts.archive === b.scripts.archive
  )
}

export type LocalCommandSourcePolicyNotice =
  | { kind: 'checking' }
  | { kind: 'action'; policy: 'local-only' | 'run-both'; label: string }

export function getLocalCommandSourcePolicyNotice({
  hooksInspectionReady,
  currentPolicy,
  setupScript,
  archiveScript,
  hasSharedScript
}: {
  hooksInspectionReady: boolean
  currentPolicy: HookCommandSourcePolicy
  setupScript: string | undefined
  archiveScript: string | undefined
  hasSharedScript: boolean
}): LocalCommandSourcePolicyNotice | null {
  if (!setupScript?.trim() && !archiveScript?.trim()) {
    return null
  }
  if (currentPolicy !== 'shared-only') {
    return null
  }
  if (!hooksInspectionReady) {
    return { kind: 'checking' }
  }
  return hasSharedScript
    ? {
        kind: 'action',
        policy: 'run-both',
        label: translate('auto.components.settings.RepositoryHooksSection.8d6c56bff8', 'Run both')
      }
    : {
        kind: 'action',
        policy: 'local-only',
        label: translate(
          'auto.components.settings.RepositoryHooksSection.8bfe65fc60',
          'Use local commands'
        )
      }
}

const YAML_STATE_STYLES: Record<string, { card: string; titleClassName: string }> = {
  loaded: {
    card: 'border-emerald-500/20 bg-emerald-500/5',
    titleClassName: 'text-emerald-700 dark:text-emerald-300'
  },
  'update-available': {
    card: 'border-amber-500/20 bg-amber-500/5',
    titleClassName: 'text-amber-700 dark:text-amber-300'
  },
  invalid: {
    card: 'border-amber-500/20 bg-amber-500/5',
    titleClassName: 'text-amber-700 dark:text-amber-300'
  },
  missing: {
    card: 'border-border/50 bg-muted/20',
    titleClassName: 'text-foreground'
  }
}

function getSetupRunPolicyOptions(): PolicyOption<SetupRunPolicy>[] {
  return [
    {
      policy: 'ask',
      label: translate(
        'auto.components.settings.RepositoryHooksSection.e03d9a8f38',
        'Ask every time'
      ),
      description: translate(
        'auto.components.settings.RepositoryHooksSection.90b1f50137',
        'Prompt before running setup.'
      )
    },
    {
      policy: 'run-by-default',
      label: translate(
        'auto.components.settings.RepositoryHooksSection.d3ef1ab247',
        'Run by default'
      ),
      description: translate(
        'auto.components.settings.RepositoryHooksSection.022ba10cf2',
        'Run setup automatically.'
      )
    },
    {
      policy: 'skip-by-default',
      label: translate(
        'auto.components.settings.RepositoryHooksSection.15debc1fd9',
        'Skip by default'
      ),
      description: translate(
        'auto.components.settings.RepositoryHooksSection.99e3264a49',
        'Only run setup when chosen.'
      )
    }
  ]
}

function getCommandSourcePolicyOptions(): PolicyOption<HookCommandSourcePolicy>[] {
  return [
    {
      policy: 'shared-only',
      label: translate(
        'auto.components.settings.RepositoryHooksSection.d88b6ff88f',
        'orca.yaml only'
      ),
      description: translate(
        'auto.components.settings.RepositoryHooksSection.29397e8bbc',
        'Run only committed repo commands; ignore local commands.'
      )
    },
    {
      policy: 'local-only',
      label: translate('auto.components.settings.RepositoryHooksSection.83dc78202a', 'Local only'),
      description: translate(
        'auto.components.settings.RepositoryHooksSection.0e8b2a520d',
        'Ignore orca.yaml; run only your local commands.'
      )
    },
    {
      policy: 'run-both',
      label: translate('auto.components.settings.RepositoryHooksSection.8d6c56bff8', 'Run both'),
      description: translate(
        'auto.components.settings.RepositoryHooksSection.8561b0665f',
        'orca.yaml first, then your local commands.'
      )
    }
  ]
}

function getCommandSourceLabel(policy: HookCommandSourcePolicy): string {
  switch (policy) {
    case 'shared-only':
      return translate(
        'auto.components.settings.RepositoryHooksSection.d88b6ff88f',
        'orca.yaml only'
      )
    case 'local-only':
      return translate('auto.components.settings.RepositoryHooksSection.83dc78202a', 'Local only')
    case 'run-both':
      return translate('auto.components.settings.RepositoryHooksSection.8d6c56bff8', 'Run both')
  }
}

function getLocalHookFields(): readonly [LocalHookField, LocalHookField] {
  return [
    {
      name: 'setup',
      label: translate(
        'auto.components.settings.RepositoryHooksSection.52b31baf02',
        'Setup Script'
      ),
      description: translate(
        'auto.components.settings.RepositoryHooksSection.f0710e1c83',
        'Runs after a new worktree is created; install deps, copy env files, run migrations.'
      ),
      placeholder: translate(
        'auto.components.settings.RepositoryHooksSection.a3fc966677',
        '# e.g. pnpm install cp "$ORCA_ROOT_PATH/.env" "$ORCA_WORKTREE_PATH/.env"'
      )
    },
    {
      name: 'archive',
      label: translate(
        'auto.components.settings.RepositoryHooksSection.9a100323ff',
        'Archive Script'
      ),
      description: translate(
        'auto.components.settings.RepositoryHooksSection.6f90ebe3fd',
        'Runs before a worktree is archived or removed.'
      ),
      placeholder: translate(
        'auto.components.settings.RepositoryHooksSection.9b821fa19d',
        '# e.g. echo "Cleaning up $ORCA_WORKSPACE_NAME"'
      )
    }
  ]
}

function getEnvVars(): readonly { name: string; description: string }[] {
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

function getYamlStateCopy(yamlState: string): { heading: string; description: string } {
  switch (yamlState) {
    case 'loaded':
      return {
        heading: translate(
          'auto.components.settings.RepositoryHooksSection.56f9a4a1d0',
          'Using `orca.yaml`'
        ),
        description: translate(
          'auto.components.settings.RepositoryHooksSection.ca424ff135',
          'Shared hook and issue-automation defaults are defined in the repo and available to everyone who uses it.'
        )
      }
    case 'update-available':
      return {
        heading: translate(
          'auto.components.settings.RepositoryHooksSection.623e0c9f31',
          '`orca.yaml` could not be parsed'
        ),
        description: translate(
          'auto.components.settings.RepositoryHooksSection.aba825233f',
          'The file contains configuration keys that this version of Orca does not recognize. You may need to update Orca, or check the file for typos.'
        )
      }
    case 'invalid':
      return {
        heading: translate(
          'auto.components.settings.RepositoryHooksSection.623e0c9f31',
          '`orca.yaml` could not be parsed'
        ),
        description: translate(
          'auto.components.settings.RepositoryHooksSection.0cc712b823',
          'The core configuration file exists in the repo root, but Orca could not parse the supported hook definitions yet.'
        )
      }
    default:
      return {
        heading: translate(
          'auto.components.settings.RepositoryHooksSection.5a67e4793d',
          'No `orca.yaml` detected'
        ),
        description: translate(
          'auto.components.settings.RepositoryHooksSection.b20c5df6ca',
          'Add an `orca.yaml` file to enable shared setup, archive, or issue-automation defaults for this repo. Example template:'
        )
      }
  }
}

function getParseErrorFixes(): readonly string[] {
  return [
    translate(
      'auto.components.settings.RepositoryHooksSection.07ba35bc68',
      'Check the indentation under `scripts:`. Hook keys should use two spaces, and command lines should use four.'
    ),
    translate(
      'auto.components.settings.RepositoryHooksSection.787ca433ef',
      'Define only the supported keys: `scripts`, `setup`, `archive`, and `issueCommand`.'
    ),
    translate(
      'auto.components.settings.RepositoryHooksSection.ecc73d9125',
      'Compare your file against the working template below and copy that shape if needed.'
    )
  ]
}

function PolicyOptionGrid<P extends string>({
  options,
  selected,
  onSelect,
  columns
}: {
  options: PolicyOption<P>[]
  selected: P
  onSelect: (p: P) => void
  columns: string
}): React.JSX.Element {
  return (
    <div className={`grid gap-2 ${columns}`}>
      {options.map(({ policy, label, description }) => {
        const active = selected === policy
        return (
          <button
            type="button"
            key={policy}
            onClick={() => onSelect(policy)}
            className={`rounded-xl border px-3 py-2.5 text-center transition-colors ${
              active
                ? 'border-foreground/15 bg-accent text-accent-foreground'
                : 'border-border/60 bg-background text-foreground hover:border-border hover:bg-muted/40'
            }`}
          >
            <span className={`block text-sm ${active ? 'font-semibold' : 'font-medium'}`}>
              {label}
            </span>
            <p
              className={`mt-1 text-[11px] leading-4 ${active ? 'text-accent-foreground/80' : 'text-muted-foreground'}`}
            >
              {description}
            </p>
          </button>
        )
      })}
    </div>
  )
}

function SegmentedPolicyToggle<P extends string>({
  options,
  selected,
  onSelect
}: {
  options: PolicyOption<P>[]
  selected: P
  onSelect: (p: P) => void
}): React.JSX.Element {
  return (
    <div className="inline-flex gap-0.5 rounded-lg border border-border/60 bg-muted/50 p-0.5">
      {options.map(({ policy, label, description }) => {
        const active = selected === policy
        return (
          <button
            type="button"
            key={policy}
            onClick={() => onSelect(policy)}
            title={description}
            className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
              active
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-muted-foreground hover:bg-background/60 hover:text-foreground'
            }`}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}

function ExampleTemplateCard({
  copiedTemplate,
  onCopyTemplate
}: {
  copiedTemplate: boolean
  onCopyTemplate: () => void
}): React.JSX.Element {
  return (
    <div className="space-y-2">
      <p className="text-[10px] tracking-[0.18em] text-muted-foreground">
        {translate('auto.components.settings.RepositoryHooksSection.175daba180', 'Example')}
        <code className="rounded bg-muted px-1 py-0.5">
          {translate('auto.components.settings.RepositoryHooksSection.39da2ae12f', 'orca.yaml')}
        </code>{' '}
        {translate('auto.components.settings.RepositoryHooksSection.95a0411b3e', 'template')}
      </p>
      <div className="relative rounded-lg border border-border/50 bg-background/70">
        <Button
          type="button"
          variant={copiedTemplate ? 'secondary' : 'ghost'}
          size="sm"
          className={`absolute right-2 top-2 z-10 h-6 px-2 text-[11px] ${
            copiedTemplate ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
          }`}
          onClick={onCopyTemplate}
        >
          {copiedTemplate
            ? translate('auto.components.settings.RepositoryHooksSection.3149964b66', 'Copied')
            : translate('auto.components.settings.RepositoryHooksSection.da37d6f10e', 'Copy')}
        </Button>
        <pre className="overflow-x-auto whitespace-pre-wrap break-words p-3 pr-16 font-mono text-[11px] leading-5 text-muted-foreground">
          {EXAMPLE_TEMPLATE}
        </pre>
      </div>
    </div>
  )
}

function YamlScriptBlock({ content }: { content: string }): React.JSX.Element {
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-border/50 bg-muted/30 p-3 font-mono text-[11.5px] leading-5 text-foreground">
      {content}
    </pre>
  )
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

type SaveStatus = 'idle' | 'saving' | 'saved'

function SaveIndicator({ status }: { status: SaveStatus }): React.JSX.Element | null {
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
        className={`size-1.5 rounded-full ${
          isSaving ? 'animate-pulse bg-amber-500' : 'bg-emerald-500'
        }`}
      />
      {isSaving
        ? translate('auto.components.settings.RepositoryHooksSection.81057d5f71', 'Saving...')
        : translate('auto.components.settings.RepositoryHooksSection.2b6356e744', 'Saved')}
    </span>
  )
}

function LocalCommandSourceNotice({
  notice,
  onSelectPolicy
}: {
  notice: LocalCommandSourcePolicyNotice
  onSelectPolicy: (policy: 'local-only' | 'run-both') => void
}): React.JSX.Element {
  const isChecking = notice.kind === 'checking'
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
            {isChecking
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

type ScriptEditorProps = {
  field: LocalHookField
  value: string
  hasShared: boolean
  sharedScript: string | undefined
  onChange: (next: string) => void
  onCommit: () => void
  sectionId?: string
}

function ScriptEditor({
  field,
  value,
  hasShared,
  sharedScript,
  onChange,
  onCommit,
  sectionId
}: ScriptEditorProps): React.JSX.Element {
  const [showLocal, setShowLocal] = useState(value.length > 0)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
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
    // Why: persistence is synchronous from the editor's POV, but we briefly
    // show "Saving..." then "Saved" so the indicator carries the auto-save trust
    // signal a Save button would (without the click).
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
  const editorRows = getRepositoryHookScriptTextareaRows(value)

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
              {translate('auto.components.settings.RepositoryHooksSection.b113344b6a', 'Edit')}
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
          <YamlScriptBlock content={sharedScript ?? ''} />
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
            rows={editorRows}
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

export function RepositoryHooksSection({
  repo,
  yamlHooks,
  hasHooksFile,
  hooksInspectionReady,
  mayNeedUpdate,
  copiedTemplate,
  forceVisible = false,
  onCopyTemplate,
  onUpdateHookSettings
}: RepositoryHooksSectionProps): React.JSX.Element {
  // Why: this component uses the lightweight translate() helper; subscribe here
  // so render-time option/copy builders refresh when the UI language changes.
  useTranslation()
  const settingsSearchQuery = useAppStore((s) => s.settingsSearchQuery)
  const selectedHostId = getRepoExecutionHostId(repo)
  const repoHostIdentity = `${selectedHostId}\0${repo.id}`
  const hookRuntimeSettings = useMemo(() => {
    const parsedHost = parseExecutionHostId(selectedHostId)
    return {
      activeRuntimeEnvironmentId: parsedHost?.kind === 'runtime' ? parsedHost.environmentId : null
    }
  }, [selectedHostId])
  const yamlState = yamlHooks
    ? 'loaded'
    : hasHooksFile
      ? mayNeedUpdate
        ? 'update-available'
        : 'invalid'
      : 'missing'

  const [hookSettingsDraft, setHookSettingsDraft] = useState(() =>
    getHookSettingsDraft(repo.hookSettings)
  )
  const hookSettingsDraftRef = useRef(hookSettingsDraft)
  hookSettingsDraftRef.current = hookSettingsDraft
  const localCommandsRepoIdentityRef = useRef(repoHostIdentity)
  const localCommandsDraftDirtyRef = useRef(false)
  const localCommandsAutosaveTimerRef = useRef<number | null>(null)
  const persistRef = useRef(onUpdateHookSettings)
  persistRef.current = onUpdateHookSettings
  const localCommandsPersistForRepoRef = useRef(onUpdateHookSettings)

  const selectedSetupRunPolicy: SetupRunPolicy =
    hookSettingsDraft.setupRunPolicy ?? 'run-by-default'
  const selectedSetupAgentStartupPolicy: SetupAgentStartupPolicy =
    hookSettingsDraft.setupAgentStartupPolicy ?? 'start-immediately'
  const setupRunPolicyOptions = getSetupRunPolicyOptions()
  const commandSourcePolicyOptions = getCommandSourcePolicyOptions()
  const localHookFields = getLocalHookFields()
  const yamlStateCopy = getYamlStateCopy(yamlState)
  const parseErrorFixes = getParseErrorFixes()

  const [issueCommandDraft, setIssueCommandDraft] = useState('')
  const [hasSharedIssueCommand, setHasSharedIssueCommand] = useState(false)
  const [issueCommandSaveError, setIssueCommandSaveError] = useState<string | null>(null)
  const issueCommandDraftRef = useRef(issueCommandDraft)
  issueCommandDraftRef.current = issueCommandDraft
  const lastCommittedIssueCommandRef = useRef('')

  const syncHookSettingsDraft = useCallback((next: RepoHookSettings) => {
    if (areHookSettingsDraftsEqual(hookSettingsDraftRef.current, next)) {
      return
    }
    hookSettingsDraftRef.current = next
    setHookSettingsDraft(next)
  }, [])

  const persistHookSettings = useCallback((next: RepoHookSettings) => {
    hookSettingsDraftRef.current = next
    setHookSettingsDraft(next)
    localCommandsDraftDirtyRef.current = false
    persistRef.current(next)
  }, [])

  const clearLocalCommandsAutosaveTimer = useCallback(() => {
    if (localCommandsAutosaveTimerRef.current !== null) {
      window.clearTimeout(localCommandsAutosaveTimerRef.current)
      localCommandsAutosaveTimerRef.current = null
    }
  }, [])

  const flushScriptDraft = useCallback(
    (persistHookSettings?: (settings: RepoHookSettings) => void) => {
      clearLocalCommandsAutosaveTimer()
      if (!localCommandsDraftDirtyRef.current) {
        return
      }
      localCommandsDraftDirtyRef.current = false
      const persist = persistHookSettings ?? persistRef.current
      persist(hookSettingsDraftRef.current)
    },
    [clearLocalCommandsAutosaveTimer]
  )

  const queueScriptDraftPersist = useCallback(() => {
    localCommandsDraftDirtyRef.current = true
    clearLocalCommandsAutosaveTimer()
    // Why: repo settings persistence may be an SSH RPC; coalesce typing bursts
    // so a pasted script does not enqueue one repo.update call per character.
    localCommandsAutosaveTimerRef.current = window.setTimeout(() => {
      flushScriptDraft()
    }, 700)
  }, [clearLocalCommandsAutosaveTimer, flushScriptDraft])

  const updateScriptDraft = useCallback(
    (hookName: LocalHookName, nextScript: string) => {
      const current = hookSettingsDraftRef.current
      const next: RepoHookSettings = {
        ...current,
        scripts: {
          ...current.scripts,
          [hookName]: nextScript
        }
      }
      hookSettingsDraftRef.current = next
      setHookSettingsDraft(next)
      // Why: changing local commands should not silently change Command Source;
      // if local commands are excluded, the warning below offers an explicit switch.
      queueScriptDraftPersist()
    },
    [queueScriptDraftPersist]
  )

  const commitScriptDraft = useCallback(() => {
    flushScriptDraft()
  }, [flushScriptDraft])

  // Why: unmount can happen before textareas blur; the root ref preserves the
  // pending local-command save without paying for a cleanup-only Effect.
  const flushScriptDraftOnUnmount = useCallback(
    (node: HTMLElement | null): void => {
      if (node === null) {
        flushScriptDraft()
      }
    },
    [flushScriptDraft]
  )

  const updateHookSettingsPolicyDraft = useCallback(
    (updates: HookSettingsPolicyDraft) => {
      persistHookSettings({ ...hookSettingsDraftRef.current, ...updates })
    },
    [persistHookSettings]
  )

  // Why: repo switches reset state before textareas can blur, so flush the
  // dirty draft through the previous repo's captured updater.
  useEffect(() => {
    const next = getHookSettingsDraft(repo.hookSettings)
    const isSameRepo = localCommandsRepoIdentityRef.current === repoHostIdentity

    if (isSameRepo) {
      localCommandsPersistForRepoRef.current = onUpdateHookSettings
      if (!localCommandsDraftDirtyRef.current) {
        syncHookSettingsDraft(next)
      }
      return
    }

    flushScriptDraft(localCommandsPersistForRepoRef.current)
    localCommandsRepoIdentityRef.current = repoHostIdentity
    localCommandsPersistForRepoRef.current = onUpdateHookSettings
    hookSettingsDraftRef.current = next
    setHookSettingsDraft(next)
  }, [
    flushScriptDraft,
    onUpdateHookSettings,
    repo.hookSettings,
    repoHostIdentity,
    syncHookSettingsDraft
  ])

  useEffect(() => {
    let cancelled = false
    const repoId = repo.id

    setIssueCommandDraft('')
    setHasSharedIssueCommand(false)
    setIssueCommandSaveError(null)

    // Why: the pane can show a host other than the globally focused runtime;
    // route both runtime RPC and local/SSH IPC by the selected repo owner.
    void readRuntimeIssueCommand(hookRuntimeSettings, repoId, selectedHostId)
      .then((result) => {
        if (cancelled) {
          return
        }
        const localContent = result.localContent ?? ''
        setIssueCommandDraft(localContent)
        setHasSharedIssueCommand(Boolean(result.sharedContent))
        lastCommittedIssueCommandRef.current = localContent
      })
      .catch(() => {
        if (!cancelled) {
          setIssueCommandDraft('')
          setHasSharedIssueCommand(false)
          lastCommittedIssueCommandRef.current = ''
        }
      })

    return () => {
      cancelled = true
      const draft = issueCommandDraftRef.current.trim()
      if (draft !== lastCommittedIssueCommandRef.current) {
        void writeRuntimeIssueCommand(hookRuntimeSettings, repoId, draft, selectedHostId).catch(
          (err) => {
            console.error('[RepositoryHooksSection] Failed to save issue command on unmount:', err)
          }
        )
      }
    }
  }, [hookRuntimeSettings, repo.id, repoHostIdentity, selectedHostId])

  const commitIssueCommand = useCallback(async (): Promise<void> => {
    const trimmed = issueCommandDraft.trim()
    setIssueCommandDraft(trimmed)
    try {
      await writeRuntimeIssueCommand(hookRuntimeSettings, repo.id, trimmed, selectedHostId)
      lastCommittedIssueCommandRef.current = trimmed
      setIssueCommandSaveError(null)
    } catch (err) {
      console.error('[RepositoryHooksSection] Failed to write issue command:', err)
      const message = err instanceof Error ? err.message : 'Failed to save GitHub issue command.'
      setIssueCommandSaveError(message)
      toast.error(message)
    }
  }, [hookRuntimeSettings, issueCommandDraft, repo.id, selectedHostId])

  const sharedSetupScript = yamlHooks?.scripts.setup
  const sharedArchiveScript = yamlHooks?.scripts.archive
  const hasSharedSetupScript = Boolean(sharedSetupScript?.trim())
  const hasSharedArchiveScript = Boolean(sharedArchiveScript?.trim())
  const hasSharedScript = Boolean(sharedSetupScript?.trim() || sharedArchiveScript?.trim())
  const hasLocalScript = Boolean(
    hookSettingsDraft.scripts.setup?.trim() || hookSettingsDraft.scripts.archive?.trim()
  )
  const selectedCommandSourcePolicy: HookCommandSourcePolicy = resolveHookCommandSourcePolicy(
    hookSettingsDraft.commandSourcePolicy,
    { hasLocalScript }
  )
  const localCommandSourceNotice = getLocalCommandSourcePolicyNotice({
    hooksInspectionReady,
    currentPolicy: selectedCommandSourcePolicy,
    setupScript: hookSettingsDraft.scripts.setup,
    archiveScript: hookSettingsDraft.scripts.archive,
    hasSharedScript
  })
  const advancedMatchesSearch =
    settingsSearchQuery.trim() !== '' &&
    matchesSettingsSearch(settingsSearchQuery, {
      title: translate('auto.components.settings.RepositoryHooksSection.c9bc1bfd8f', 'Advanced'),
      description: translate(
        'auto.components.settings.RepositoryHooksSection.610d90fdbd',
        'Command source and orca.yaml details.'
      ),
      keywords: [
        translate('auto.components.settings.RepositoryHooksSection.c5a55a2d2e', 'advanced'),
        translate('auto.components.settings.RepositoryHooksSection.4611b78617', 'command source'),
        translate('auto.components.settings.RepositoryHooksSection.39da2ae12f', 'orca.yaml'),
        translate('auto.components.settings.RepositoryHooksSection.d2b3016c20', 'shared'),
        translate('auto.components.settings.RepositoryHooksSection.2d03a514db', 'local'),
        translate('auto.components.settings.RepositoryHooksSection.0518758f38', 'both'),
        translate('auto.components.settings.RepositoryHooksSection.fac13f8c1e', 'authoritative')
      ]
    })
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false)

  return (
    <section ref={flushScriptDraftOnUnmount} className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">
          {translate(
            'auto.components.settings.RepositoryHooksSection.ff082fe7c6',
            'Worktree Hooks'
          )}
        </h2>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.RepositoryHooksSection.8567127a40',
            'Scripts that run when worktrees are created or archived. Local scripts are stored on this machine; `orca.yaml` scripts are shared with your team.'
          )}
        </p>
      </div>

      <SearchableSetting
        title={translate(
          'auto.components.settings.RepositoryHooksSection.52b31baf02',
          'Setup Script'
        )}
        description={translate(
          'auto.components.settings.RepositoryHooksSection.30d555acd2',
          'Local and shared scripts that run after a new worktree is created.'
        )}
        forceVisible={forceVisible}
        keywords={[
          'setup',
          'script',
          'command',
          'local',
          'local settings scripts',
          'orca.yaml',
          'orca.yaml hooks',
          'hook'
        ]}
      >
        <ScriptEditor
          key={`${repo.id}:setup`}
          field={localHookFields[0]}
          value={hookSettingsDraft.scripts.setup ?? ''}
          hasShared={hasSharedSetupScript}
          sharedScript={sharedSetupScript}
          onChange={(next) => updateScriptDraft('setup', next)}
          onCommit={commitScriptDraft}
          sectionId={getRepositoryLocalCommandsSectionId(repo.id)}
        />
      </SearchableSetting>

      <SearchableSetting
        title={translate(
          'auto.components.settings.RepositoryHooksSection.fb6bebcf7e',
          'When to Run Setup'
        )}
        description={translate(
          'auto.components.settings.RepositoryHooksSection.63e1783173',
          'Choose the default behavior when a setup script is available.'
        )}
        forceVisible={forceVisible}
        keywords={['setup run policy', 'ask', 'run by default', 'skip by default']}
      >
        <div className="space-y-4 rounded-2xl border border-border/50 bg-background/80 p-4 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h5 className="text-sm font-semibold">
                {translate(
                  'auto.components.settings.RepositoryHooksSection.793dcee97d',
                  'When to run'
                )}
              </h5>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.RepositoryHooksSection.21fb607a87',
                  'Default behavior when a new worktree is created.'
                )}
              </p>
            </div>
            <SegmentedPolicyToggle
              options={setupRunPolicyOptions}
              selected={selectedSetupRunPolicy}
              onSelect={(policy) => updateHookSettingsPolicyDraft({ setupRunPolicy: policy })}
            />
          </div>
          <div className="flex items-start justify-between gap-4 border-t border-border/60 pt-4">
            <div className="min-w-0 space-y-1">
              <h5 className="text-sm font-semibold">
                {translate(
                  'auto.components.settings.RepositoryHooksSection.waitForSetupBeforeAgent',
                  'Wait for setup to complete before starting agent'
                )}
              </h5>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.RepositoryHooksSection.waitForSetupBeforeAgentHelp',
                  'Turn this on when setup installs dependencies, MCP servers, or config files the agent needs during startup.'
                )}
              </p>
            </div>
            <SettingsSwitch
              checked={selectedSetupAgentStartupPolicy === 'wait-for-setup'}
              onChange={() =>
                updateHookSettingsPolicyDraft({
                  setupAgentStartupPolicy:
                    selectedSetupAgentStartupPolicy === 'wait-for-setup'
                      ? 'start-immediately'
                      : 'wait-for-setup'
                })
              }
              ariaLabel={translate(
                'auto.components.settings.RepositoryHooksSection.waitForSetupBeforeAgent',
                'Wait for setup to complete before starting agent'
              )}
            />
          </div>
        </div>
      </SearchableSetting>

      <SearchableSetting
        title={translate(
          'auto.components.settings.RepositoryHooksSection.9a100323ff',
          'Archive Script'
        )}
        description={translate(
          'auto.components.settings.RepositoryHooksSection.b91a0f297d',
          'Local and shared scripts that run before a worktree is archived.'
        )}
        forceVisible={forceVisible}
        keywords={[
          'archive',
          'script',
          'command',
          'local',
          'local settings scripts',
          'orca.yaml',
          'orca.yaml hooks',
          'hook'
        ]}
      >
        <ScriptEditor
          key={`${repo.id}:archive`}
          field={localHookFields[1]}
          value={hookSettingsDraft.scripts.archive ?? ''}
          hasShared={hasSharedArchiveScript}
          sharedScript={sharedArchiveScript}
          onChange={(next) => updateScriptDraft('archive', next)}
          onCommit={commitScriptDraft}
        />
      </SearchableSetting>

      {localCommandSourceNotice ? (
        <LocalCommandSourceNotice
          notice={localCommandSourceNotice}
          onSelectPolicy={(policy) =>
            updateHookSettingsPolicyDraft({ commandSourcePolicy: policy })
          }
        />
      ) : null}

      <SearchableSetting
        title={translate(
          'auto.components.settings.RepositoryHooksSection.13394103bd',
          'Custom GitHub Issue Command'
        )}
        description={translate(
          'auto.components.settings.RepositoryHooksSection.2cc27dc12b',
          'Optional per-user override for the linked-issue command.'
        )}
        forceVisible={forceVisible}
        keywords={['github issue command', 'issue command', 'workflow', 'agent', 'github']}
      >
        <div className="space-y-3 rounded-2xl border border-border/50 bg-background/80 p-4 shadow-sm">
          <div className="space-y-1">
            <h5 className="text-sm font-semibold">
              {translate(
                'auto.components.settings.RepositoryHooksSection.13394103bd',
                'Custom GitHub Issue Command'
              )}
            </h5>
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.RepositoryHooksSection.b997331366',
                'Optional override. Use'
              )}{' '}
              <code className="rounded bg-muted px-1 py-0.5">
                {translate(
                  'auto.components.settings.RepositoryHooksSection.c85c2c88a2',
                  '{{artifact_url}}',
                  { artifact_url: ARTIFACT_URL_TEMPLATE_TOKEN }
                )}
              </code>{' '}
              {translate(
                'auto.components.settings.RepositoryHooksSection.70ad20f883',
                'for the linked issue or PR URL.'
              )}
            </p>
          </div>
          <textarea
            value={issueCommandDraft}
            aria-label={translate(
              'auto.components.settings.RepositoryHooksSection.13394103bd',
              'Custom GitHub Issue Command'
            )}
            onChange={(e) => setIssueCommandDraft(e.target.value)}
            onBlur={commitIssueCommand}
            placeholder={translate(
              'auto.components.settings.RepositoryHooksSection.4084720f47',
              'Complete {{artifact_url}}',
              { artifact_url: ARTIFACT_URL_TEMPLATE_TOKEN }
            )}
            rows={4}
            spellCheck={false}
            className="w-full min-w-0 resize-y rounded-md border border-input bg-muted/20 px-3 py-2 font-mono text-xs shadow-xs transition-[color,box-shadow] outline-none placeholder:italic placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:bg-background focus-visible:ring-[3px] focus-visible:ring-ring/40"
          />
          <p className="text-[11px] text-muted-foreground">
            {translate(
              'auto.components.settings.RepositoryHooksSection.52aef29e69',
              'Leave blank to use the repo default from'
            )}{' '}
            <code className="rounded bg-muted px-1 py-0.5">
              {translate('auto.components.settings.RepositoryHooksSection.39da2ae12f', 'orca.yaml')}
            </code>
            {hasSharedIssueCommand
              ? '.'
              : translate(
                  'auto.components.settings.RepositoryHooksSection.9b12f15b1e',
                  'when one exists.'
                )}
          </p>
          {issueCommandSaveError ? (
            <p className="text-xs text-destructive">{issueCommandSaveError}</p>
          ) : null}
        </div>
      </SearchableSetting>

      <SearchableSetting
        title={translate('auto.components.settings.RepositoryHooksSection.c9bc1bfd8f', 'Advanced')}
        description={translate(
          'auto.components.settings.RepositoryHooksSection.610d90fdbd',
          'Command source and orca.yaml details.'
        )}
        forceVisible={forceVisible}
        keywords={[
          'advanced',
          'command source',
          'orca.yaml',
          'shared',
          'local',
          'both',
          'authoritative'
        ]}
      >
        <details
          className="group rounded-2xl border border-border/50 bg-background/80 shadow-sm"
          open={advancedMatchesSearch || isAdvancedOpen}
          onToggle={(event) => {
            if (advancedMatchesSearch) {
              event.currentTarget.open = true
              return
            }
            setIsAdvancedOpen(event.currentTarget.open)
          }}
        >
          <summary
            className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden"
            onClick={(event) => {
              if (advancedMatchesSearch) {
                event.preventDefault()
              }
            }}
          >
            <div className="flex items-center gap-2">
              <ChevronRight className="size-3.5 text-muted-foreground transition-transform group-open:rotate-90" />
              <h5 className="text-sm font-semibold">
                {translate(
                  'auto.components.settings.RepositoryHooksSection.c9bc1bfd8f',
                  'Advanced'
                )}
              </h5>
              <span className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.RepositoryHooksSection.bbbd6e0bc4',
                  'Command source & orca.yaml'
                )}
              </span>
            </div>
            <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-foreground">
              {getCommandSourceLabel(selectedCommandSourcePolicy)}
            </span>
          </summary>

          <div className="space-y-5 border-t border-border/50 px-4 py-4">
            <div className="space-y-3">
              <div className="space-y-1">
                <p className="text-sm font-medium">
                  {translate(
                    'auto.components.settings.RepositoryHooksSection.32fec28f5b',
                    'Command Source'
                  )}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {translate(
                    'auto.components.settings.RepositoryHooksSection.ac9038d2cc',
                    'When both'
                  )}
                  <code className="rounded bg-muted px-1 py-0.5">
                    {translate(
                      'auto.components.settings.RepositoryHooksSection.39da2ae12f',
                      'orca.yaml'
                    )}
                  </code>{' '}
                  {translate(
                    'auto.components.settings.RepositoryHooksSection.3397879bee',
                    'and local commands exist, choose which run.'
                  )}
                </p>
              </div>
              <PolicyOptionGrid
                options={commandSourcePolicyOptions}
                selected={selectedCommandSourcePolicy}
                onSelect={(policy) =>
                  updateHookSettingsPolicyDraft({ commandSourcePolicy: policy })
                }
                columns="md:grid-cols-3"
              />
            </div>

            <div className={`space-y-3 rounded-xl border p-3 ${YAML_STATE_STYLES[yamlState].card}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <p
                    className={`text-sm font-medium ${YAML_STATE_STYLES[yamlState].titleClassName}`}
                  >
                    {yamlStateCopy.heading}
                  </p>
                  <p className="text-xs text-muted-foreground">{yamlStateCopy.description}</p>
                </div>
              </div>

              {yamlState === 'loaded' ? (
                <YamlScriptBlock content={renderYamlScriptPreview(yamlHooks)} />
              ) : yamlState === 'invalid' ? (
                <div className="space-y-4">
                  <div className="flex items-start gap-3 rounded-lg border border-amber-500/20 bg-background/60 p-3">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-300" />
                    <div className="space-y-2 text-xs text-muted-foreground">
                      <p>
                        {translate(
                          'auto.components.settings.RepositoryHooksSection.af49e2a19e',
                          'The file is present, but Orca could not find valid `scripts` or `issueCommand` definitions.'
                        )}
                      </p>
                      <ol className="space-y-1.5 pl-4 text-[11.5px]">
                        {parseErrorFixes.map((fix) => (
                          <li key={fix} className="list-decimal leading-5">
                            {fix}
                          </li>
                        ))}
                      </ol>
                    </div>
                  </div>
                  <ExampleTemplateCard
                    copiedTemplate={copiedTemplate}
                    onCopyTemplate={onCopyTemplate}
                  />
                </div>
              ) : (
                <ExampleTemplateCard
                  copiedTemplate={copiedTemplate}
                  onCopyTemplate={onCopyTemplate}
                />
              )}
            </div>
          </div>
        </details>
      </SearchableSetting>
    </section>
  )
}

function renderYamlScriptPreview(hooks: OrcaHooks | null): string {
  const fmt = (key: string, cmd?: string): string =>
    cmd ? `\n  ${key}: |\n${cmd.replace(/^/gm, '    ')}` : ''
  const issueCommand = hooks?.issueCommand
    ? `\nissueCommand: |\n${hooks.issueCommand.replace(/^/gm, '  ')}`
    : ''
  return `scripts:${fmt('setup', hooks?.scripts.setup)}${fmt('archive', hooks?.scripts.archive)}${issueCommand}`
}
