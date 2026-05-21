/* eslint-disable max-lines -- Why: the script editor, advanced/Command Source disclosure, issue-command override, and YAML state surfaces share tightly coupled state and persistence; splitting them across files would scatter prop drilling. */
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  HookCommandSourcePolicy,
  OrcaHooks,
  Repo,
  RepoHookSettings,
  SetupRunPolicy
} from '../../../../shared/types'
import { AlertTriangle, ChevronRight, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '../ui/button'
import { SearchableSetting } from './SearchableSetting'
import { useAppStore } from '@/store'
import { readRuntimeIssueCommand, writeRuntimeIssueCommand } from '@/runtime/runtime-hooks-client'
import { DEFAULT_REPO_HOOK_SETTINGS } from './SettingsConstants'
import { normalizeHookCommandSourcePolicy } from '../../../../shared/hook-command-source-policy'
import { getRepositoryLocalCommandsSectionId } from './repository-settings-targets'

type RepositoryHooksSectionProps = {
  repo: Repo
  yamlHooks: OrcaHooks | null
  hasHooksFile: boolean
  mayNeedUpdate: boolean
  copiedTemplate: boolean
  onCopyTemplate: () => void
  onUpdateHookSettings: (settings: RepoHookSettings) => void
}

type PolicyOption<P> = { policy: P; label: string; description: string }
const LOCAL_HOOK_NAMES = ['setup', 'archive'] as const
type LocalHookName = (typeof LOCAL_HOOK_NAMES)[number]
type HookSettingsPolicyDraft = Partial<
  Pick<RepoHookSettings, 'setupRunPolicy' | 'commandSourcePolicy'>
>

const SETUP_RUN_POLICY_OPTIONS: PolicyOption<SetupRunPolicy>[] = [
  { policy: 'ask', label: 'Ask every time', description: 'Prompt before running setup.' },
  { policy: 'run-by-default', label: 'Run by default', description: 'Run setup automatically.' },
  {
    policy: 'skip-by-default',
    label: 'Skip by default',
    description: 'Only run setup when chosen.'
  }
]

const COMMAND_SOURCE_POLICY_OPTIONS: PolicyOption<HookCommandSourcePolicy>[] = [
  {
    policy: 'shared-only',
    label: 'orca.yaml only',
    description: 'Run only committed repo commands; ignore local.'
  },
  {
    policy: 'local-only',
    label: 'Local only',
    description: 'Ignore orca.yaml; run only your local commands.'
  },
  {
    policy: 'run-both',
    label: 'Run both',
    description: 'orca.yaml first, then your local commands.'
  }
]

const COMMAND_SOURCE_LABEL: Record<HookCommandSourcePolicy, string> = {
  'shared-only': 'orca.yaml only',
  'local-only': 'Local only',
  'run-both': 'Run both'
}

type LocalHookField = {
  name: LocalHookName
  label: string
  description: string
  placeholder: string
}

const LOCAL_HOOK_FIELDS: LocalHookField[] = [
  {
    name: 'setup',
    label: 'Setup Command',
    description:
      'Runs after a new worktree is created; install deps, copy env files, run migrations.',
    placeholder: '# e.g.\npnpm install\ncp "$ORCA_ROOT_PATH/.env" "$ORCA_WORKTREE_PATH/.env"'
  },
  {
    name: 'archive',
    label: 'Archive Command',
    description: 'Runs before a worktree is archived or removed.',
    placeholder: '# e.g.\necho "Cleaning up $ORCA_WORKSPACE_NAME"'
  }
]

const ENV_VARS = ['$ORCA_ROOT_PATH', '$ORCA_WORKTREE_PATH', '$ORCA_WORKSPACE_NAME'] as const

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

const YAML_STATE_STYLES: Record<
  string,
  { card: string; title: string; heading: string; description: string }
> = {
  loaded: {
    card: 'border-emerald-500/20 bg-emerald-500/5',
    title: 'text-emerald-700 dark:text-emerald-300',
    heading: 'Using `orca.yaml`',
    description:
      'Shared hook and issue-automation defaults are defined in the repo and available to everyone who uses it.'
  },
  'update-available': {
    card: 'border-amber-500/20 bg-amber-500/5',
    title: 'text-amber-700 dark:text-amber-300',
    heading: '`orca.yaml` could not be parsed',
    description:
      'The file contains configuration keys that this version of Orca does not recognize. You may need to update Orca, or check the file for typos.'
  },
  invalid: {
    card: 'border-amber-500/20 bg-amber-500/5',
    title: 'text-amber-700 dark:text-amber-300',
    heading: '`orca.yaml` could not be parsed',
    description:
      'The core configuration file exists in the repo root, but Orca could not parse the supported hook definitions yet.'
  },
  missing: {
    card: 'border-border/50 bg-muted/20',
    title: 'text-foreground',
    heading: 'No `orca.yaml` detected',
    description:
      'Add an `orca.yaml` file to enable shared setup, archive, or issue-automation defaults for this repo. Example template:'
  }
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
        Example <code className="rounded bg-muted px-1 py-0.5">orca.yaml</code> template
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
          {copiedTemplate ? 'Copied' : 'Copy'}
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
  return (
    <div className="flex flex-wrap gap-1.5">
      {ENV_VARS.map((name) => (
        <code
          key={name}
          className="rounded-md border border-border/50 bg-muted/35 px-2 py-1 font-mono text-[11px] text-muted-foreground"
        >
          {name}
        </code>
      ))}
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

  useEffect(() => {
    // Why: when the repo or its persisted local script changes (e.g. switching repos),
    // re-evaluate whether the local block should be visible by default.
    if (value.length > 0) {
      setShowLocal(true)
    }
  }, [value])

  const showLocalEditor = showLocal || !hasShared
  const lineCount = value ? value.split('\n').length : 0

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
              orca.yaml
              <span className="font-normal text-emerald-700/80 dark:text-emerald-300/80">
                - shared with your team
              </span>
            </span>
            <span className="text-[11px] text-muted-foreground">
              Edit <code className="rounded bg-muted px-1 py-0.5">orca.yaml</code> to change.
            </span>
          </div>
          <YamlScriptBlock content={sharedScript ?? ''} />
        </div>
      ) : null}

      {showLocalEditor ? (
        <div className="space-y-2">
          {hasShared ? (
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/30 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                local
                <span className="font-normal">- just for you, on this machine</span>
              </span>
            </div>
          ) : null}
          <textarea
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onBlur={onCommit}
            placeholder={field.placeholder}
            spellCheck={false}
            rows={Math.min(Math.max(lineCount + 1, 4), 14)}
            className="w-full min-w-0 resize-y rounded-lg border border-input bg-muted/20 px-3 py-2 font-mono text-[12px] leading-[1.55] shadow-xs transition-[color,box-shadow] outline-none placeholder:italic placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:bg-background focus-visible:ring-[3px] focus-visible:ring-ring/40"
          />
          <p className="text-[11px] text-muted-foreground">
            Runs as a single shell script. Saved on this machine.
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
          Add local override
        </Button>
      )}
    </div>
  )
}

export function RepositoryHooksSection({
  repo,
  yamlHooks,
  hasHooksFile,
  mayNeedUpdate,
  copiedTemplate,
  onCopyTemplate,
  onUpdateHookSettings
}: RepositoryHooksSectionProps): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
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
  const localCommandsRepoIdRef = useRef(repo.id)
  const localCommandsDraftDirtyRef = useRef(false)
  const persistRef = useRef(onUpdateHookSettings)
  persistRef.current = onUpdateHookSettings
  const localCommandsPersistForRepoRef = useRef(onUpdateHookSettings)

  const selectedSetupRunPolicy: SetupRunPolicy =
    hookSettingsDraft.setupRunPolicy ?? 'run-by-default'
  const selectedCommandSourcePolicy: HookCommandSourcePolicy = normalizeHookCommandSourcePolicy(
    hookSettingsDraft.commandSourcePolicy
  )

  const [issueCommandDraft, setIssueCommandDraft] = useState('')
  const [hasSharedIssueCommand, setHasSharedIssueCommand] = useState(false)
  const [issueCommandSaveError, setIssueCommandSaveError] = useState<string | null>(null)
  const issueCommandDraftRef = useRef(issueCommandDraft)
  issueCommandDraftRef.current = issueCommandDraft
  const lastCommittedIssueCommandRef = useRef('')

  const persistHookSettings = useCallback((next: RepoHookSettings) => {
    hookSettingsDraftRef.current = next
    setHookSettingsDraft(next)
    localCommandsDraftDirtyRef.current = false
    persistRef.current(next)
  }, [])

  const updateScriptDraft = useCallback((hookName: LocalHookName, nextScript: string) => {
    const next: RepoHookSettings = {
      ...hookSettingsDraftRef.current,
      scripts: {
        ...hookSettingsDraftRef.current.scripts,
        [hookName]: nextScript
      }
    }
    hookSettingsDraftRef.current = next
    setHookSettingsDraft(next)
    localCommandsDraftDirtyRef.current = true
  }, [])

  const commitScriptDraft = useCallback(() => {
    if (!localCommandsDraftDirtyRef.current) {
      return
    }
    persistRef.current(hookSettingsDraftRef.current)
    localCommandsDraftDirtyRef.current = false
  }, [])

  const updateHookSettingsPolicyDraft = useCallback(
    (updates: HookSettingsPolicyDraft) => {
      persistHookSettings({ ...hookSettingsDraftRef.current, ...updates })
    },
    [persistHookSettings]
  )

  // Why: repo switches reset state before textareas can blur, so flush the
  // dirty draft through the previous repo's captured updater.
  useEffect(() => {
    if (localCommandsRepoIdRef.current === repo.id) {
      localCommandsPersistForRepoRef.current = onUpdateHookSettings
      return
    }
    if (localCommandsDraftDirtyRef.current) {
      localCommandsPersistForRepoRef.current(hookSettingsDraftRef.current)
      localCommandsDraftDirtyRef.current = false
    }
    localCommandsRepoIdRef.current = repo.id
    localCommandsPersistForRepoRef.current = onUpdateHookSettings
    const next = getHookSettingsDraft(repo.hookSettings)
    hookSettingsDraftRef.current = next
    setHookSettingsDraft(next)
  }, [onUpdateHookSettings, repo.id, repo.hookSettings])

  useEffect(() => {
    return () => {
      if (localCommandsDraftDirtyRef.current) {
        persistRef.current(hookSettingsDraftRef.current)
        localCommandsDraftDirtyRef.current = false
      }
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const repoId = repo.id

    setIssueCommandDraft('')
    setHasSharedIssueCommand(false)
    setIssueCommandSaveError(null)

    void readRuntimeIssueCommand(settings, repoId)
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
        void writeRuntimeIssueCommand(settings, repoId, draft).catch((err) => {
          console.error('[RepositoryHooksSection] Failed to save issue command on unmount:', err)
        })
      }
    }
  }, [repo.id, settings])

  const commitIssueCommand = useCallback(async (): Promise<void> => {
    const trimmed = issueCommandDraft.trim()
    setIssueCommandDraft(trimmed)
    try {
      await writeRuntimeIssueCommand(settings, repo.id, trimmed)
      lastCommittedIssueCommandRef.current = trimmed
      setIssueCommandSaveError(null)
    } catch (err) {
      console.error('[RepositoryHooksSection] Failed to write issue command:', err)
      const message = err instanceof Error ? err.message : 'Failed to save GitHub issue command.'
      setIssueCommandSaveError(message)
      toast.error(message)
    }
  }, [issueCommandDraft, repo.id, settings])

  const sharedSetupScript = yamlHooks?.scripts.setup
  const sharedArchiveScript = yamlHooks?.scripts.archive

  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">Worktree Hooks</h2>
        <p className="text-xs text-muted-foreground">
          Commands that run when worktrees are created or archived. Stored locally on this machine
          unless an `orca.yaml` shares them with your team.
        </p>
      </div>

      <SearchableSetting
        title="Setup Command"
        description="Local and shared commands that run after a new worktree is created."
        keywords={[
          'setup',
          'command',
          'local',
          'local settings commands',
          'orca.yaml',
          'orca.yaml hooks',
          'hook'
        ]}
      >
        <ScriptEditor
          key={`${repo.id}:setup`}
          field={LOCAL_HOOK_FIELDS[0]}
          value={hookSettingsDraft.scripts.setup ?? ''}
          hasShared={Boolean(sharedSetupScript)}
          sharedScript={sharedSetupScript}
          onChange={(next) => updateScriptDraft('setup', next)}
          onCommit={commitScriptDraft}
          sectionId={getRepositoryLocalCommandsSectionId(repo.id)}
        />
      </SearchableSetting>

      <SearchableSetting
        title="When to Run Setup"
        description="Choose the default behavior when a setup command is available."
        keywords={['setup run policy', 'ask', 'run by default', 'skip by default']}
      >
        <div className="space-y-3 rounded-2xl border border-border/50 bg-background/80 p-4 shadow-sm">
          <div className="space-y-1">
            <h5 className="text-sm font-semibold">When to Run Setup</h5>
            <p className="text-xs text-muted-foreground">
              Default behavior when a new worktree is created.
            </p>
          </div>
          <PolicyOptionGrid
            options={SETUP_RUN_POLICY_OPTIONS}
            selected={selectedSetupRunPolicy}
            onSelect={(policy) => updateHookSettingsPolicyDraft({ setupRunPolicy: policy })}
            columns="md:grid-cols-3"
          />
        </div>
      </SearchableSetting>

      <SearchableSetting
        title="Archive Command"
        description="Local and shared commands that run before a worktree is archived."
        keywords={[
          'archive',
          'command',
          'local',
          'local settings commands',
          'orca.yaml',
          'orca.yaml hooks',
          'hook'
        ]}
      >
        <ScriptEditor
          key={`${repo.id}:archive`}
          field={LOCAL_HOOK_FIELDS[1]}
          value={hookSettingsDraft.scripts.archive ?? ''}
          hasShared={Boolean(sharedArchiveScript)}
          sharedScript={sharedArchiveScript}
          onChange={(next) => updateScriptDraft('archive', next)}
          onCommit={commitScriptDraft}
        />
      </SearchableSetting>

      <SearchableSetting
        title="Custom GitHub Issue Command"
        description="Optional per-user override for the linked-issue command."
        keywords={['github issue command', 'issue command', 'workflow', 'agent', 'github']}
      >
        <div className="space-y-3 rounded-2xl border border-border/50 bg-background/80 p-4 shadow-sm">
          <div className="space-y-1">
            <h5 className="text-sm font-semibold">Custom GitHub Issue Command</h5>
            <p className="text-xs text-muted-foreground">
              Optional override. Use{' '}
              <code className="rounded bg-muted px-1 py-0.5">{'{{artifact_url}}'}</code> for the
              linked issue or PR URL.
            </p>
          </div>
          <textarea
            value={issueCommandDraft}
            onChange={(e) => setIssueCommandDraft(e.target.value)}
            onBlur={commitIssueCommand}
            placeholder="Complete {{artifact_url}}"
            rows={4}
            spellCheck={false}
            className="w-full min-w-0 resize-y rounded-md border border-input bg-muted/20 px-3 py-2 font-mono text-xs shadow-xs transition-[color,box-shadow] outline-none placeholder:italic placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:bg-background focus-visible:ring-[3px] focus-visible:ring-ring/40"
          />
          <p className="text-[11px] text-muted-foreground">
            Leave blank to use the repo default from{' '}
            <code className="rounded bg-muted px-1 py-0.5">orca.yaml</code>
            {hasSharedIssueCommand ? '.' : ' when one exists.'}
          </p>
          {issueCommandSaveError ? (
            <p className="text-xs text-destructive">{issueCommandSaveError}</p>
          ) : null}
        </div>
      </SearchableSetting>

      <SearchableSetting
        title="Advanced"
        description="Command source and orca.yaml details."
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
        <details className="group rounded-2xl border border-border/50 bg-background/80 shadow-sm">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
            <div className="flex items-center gap-2">
              <ChevronRight className="size-3.5 text-muted-foreground transition-transform group-open:rotate-90" />
              <h5 className="text-sm font-semibold">Advanced</h5>
              <span className="text-xs text-muted-foreground">Command source &amp; orca.yaml</span>
            </div>
            <span className="rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground">
              {COMMAND_SOURCE_LABEL[selectedCommandSourcePolicy]}
            </span>
          </summary>

          <div className="space-y-5 border-t border-border/50 px-4 py-4">
            <div className="space-y-3">
              <div className="space-y-1">
                <p className="text-sm font-medium">Command Source</p>
                <p className="text-[11px] text-muted-foreground">
                  When both <code className="rounded bg-muted px-1 py-0.5">orca.yaml</code> and
                  local commands exist, choose which run.
                </p>
              </div>
              <PolicyOptionGrid
                options={COMMAND_SOURCE_POLICY_OPTIONS}
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
                  <p className={`text-sm font-medium ${YAML_STATE_STYLES[yamlState].title}`}>
                    {YAML_STATE_STYLES[yamlState].heading}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {YAML_STATE_STYLES[yamlState].description}
                  </p>
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
                        The file is present, but Orca could not find valid `scripts` or
                        `issueCommand` definitions.
                      </p>
                      <ol className="space-y-1.5 pl-4 text-[11.5px]">
                        {PARSE_ERROR_FIXES.map((fix) => (
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

const PARSE_ERROR_FIXES = [
  'Check the indentation under `scripts:`. Hook keys should use two spaces, and command lines should use four.',
  'Define only the supported keys: `scripts`, `setup`, `archive`, and `issueCommand`.',
  'Compare your file against the working template below and copy that shape if needed.'
]

function renderYamlScriptPreview(hooks: OrcaHooks | null): string {
  const fmt = (key: string, cmd?: string): string =>
    cmd ? `\n  ${key}: |\n${cmd.replace(/^/gm, '    ')}` : ''
  const issueCommand = hooks?.issueCommand
    ? `\nissueCommand: |\n${hooks.issueCommand.replace(/^/gm, '  ')}`
    : ''
  return `scripts:${fmt('setup', hooks?.scripts.setup)}${fmt('archive', hooks?.scripts.archive)}${issueCommand}`
}
