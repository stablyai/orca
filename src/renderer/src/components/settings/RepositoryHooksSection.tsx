import type { OrcaHooks, Repo, SetupRunPolicy } from '../../../../shared/types'
import { AlertTriangle } from 'lucide-react'
import { Button } from '../ui/button'
import { DEFAULT_REPO_HOOK_SETTINGS } from './SettingsConstants'
import { SearchableSetting } from './SearchableSetting'

type RepositoryHooksSectionProps = {
  repo: Repo
  yamlHooks: OrcaHooks | null
  hasHooksFile: boolean
  copiedTemplate: boolean
  onCopyTemplate: () => void
  onClearLegacyHooks: () => void
  onUpdateSetupRunPolicy: (policy: SetupRunPolicy) => void
}

const SETUP_RUN_POLICY_OPTIONS: {
  policy: SetupRunPolicy
  label: string
  description: string
}[] = [
  {
    policy: 'ask',
    label: 'Ask every time',
    description: 'Prompt before running setup.'
  },
  {
    policy: 'run-by-default',
    label: 'Run by default',
    description: 'Run setup automatically.'
  },
  {
    policy: 'skip-by-default',
    label: 'Skip by default',
    description: 'Only run setup when chosen.'
  }
]

const EXAMPLE_TEMPLATE = `scripts:
  setup: |
    pnpm worktree:setup
  archive: |
    echo "Cleaning up before archive"`

function ExampleTemplateCard({
  copiedTemplate,
  onCopyTemplate
}: {
  copiedTemplate: boolean
  onCopyTemplate: () => void
}): React.JSX.Element {
  return (
    <div className="space-y-2">
      <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
        Example `orca.yaml` template
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

export function RepositoryHooksSection({
  repo,
  yamlHooks,
  hasHooksFile,
  copiedTemplate,
  onCopyTemplate,
  onClearLegacyHooks,
  onUpdateSetupRunPolicy
}: RepositoryHooksSectionProps): React.JSX.Element {
  const yamlState = yamlHooks ? 'loaded' : hasHooksFile ? 'invalid' : 'missing'
  const legacyHookEntries = (['setup', 'archive'] as const)
    .map((hookName) => [hookName, repo.hookSettings?.scripts[hookName]?.trim() ?? ''] as const)
    .filter(([, script]) => Boolean(script))
  const selectedSetupRunPolicy =
    repo.hookSettings?.setupRunPolicy ?? DEFAULT_REPO_HOOK_SETTINGS.setupRunPolicy

  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">Worktree Hooks</h2>
        <p className="text-xs text-muted-foreground">
          Orca prefers shared hooks from `orca.yaml` and still honors older repo-local hook scripts
          until you clear them.
        </p>
      </div>

      <SearchableSetting
        title="orca.yaml hooks"
        description="Shared setup and archive hook commands for this repository."
        keywords={['hooks', 'setup', 'archive', 'yaml']}
      >
        <div
          className={`space-y-3 rounded-xl border p-4 ${
            yamlState === 'loaded'
              ? 'border-emerald-500/20 bg-emerald-500/5'
              : yamlState === 'invalid'
                ? 'border-amber-500/20 bg-amber-500/5'
                : 'border-border/50 bg-muted/20'
          }`}
        >
          <div className="space-y-1">
            <p
              className={`text-sm font-medium ${
                yamlState === 'loaded'
                  ? 'text-emerald-700 dark:text-emerald-300'
                  : yamlState === 'invalid'
                    ? 'text-amber-700 dark:text-amber-300'
                    : 'text-foreground'
              }`}
            >
              {yamlState === 'loaded'
                ? 'Using `orca.yaml`'
                : yamlState === 'invalid'
                  ? '`orca.yaml` could not be parsed'
                  : 'No `orca.yaml` detected'}
            </p>
            <p className="text-xs text-muted-foreground">
              {yamlState === 'loaded'
                ? 'Hook commands are defined in the repo and shared with everyone who uses it.'
                : yamlState === 'invalid'
                  ? 'The core configuration file exists in the repo root, but Orca could not parse the supported hook definitions yet.'
                  : 'Add an `orca.yaml` file to enable setup or archive hooks for this repo. Example template:'}
            </p>
          </div>

          {yamlState === 'loaded' ? (
            <div className="space-y-2">
              <div className="rounded-lg border border-border/50 bg-background/70">
                <pre className="overflow-x-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-5 text-foreground">
                  {renderYamlScriptPreview(yamlHooks)}
                </pre>
              </div>
              <p className="text-xs text-muted-foreground">
                Edit `orca.yaml` in the repository if you need to change these commands.
              </p>
            </div>
          ) : yamlState === 'invalid' ? (
            <div className="space-y-5">
              <div className="flex items-start gap-3 rounded-xl border border-amber-500/20 bg-background/60 p-4">
                <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-amber-500/12 text-amber-600 dark:text-amber-300">
                  <AlertTriangle className="size-5" />
                </div>
                <div className="space-y-4">
                  <div className="space-y-2">
                    <p className="text-base font-semibold text-amber-900 dark:text-amber-100">
                      `orca.yaml` could not be parsed
                    </p>
                    <p className="text-sm leading-6 text-muted-foreground">
                      {/* Why: once a repo has an `orca.yaml`, the failure mode is usually bad shape
                      rather than a missing concept. Showing a repair-oriented explanation and
                      template here lets maintainers fix the committed file without needing the doc. */}
                      The file is present, but Orca could not find valid `setup` or `archive` hook
                      definitions in the expected format.
                    </p>
                  </div>

                  <div className="space-y-3">
                    <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                      Recommended fixes
                    </p>
                    <ol className="space-y-2.5 text-sm text-muted-foreground">
                      {PARSE_ERROR_FIXES.map((fix, index) => (
                        <li key={fix} className="flex items-start gap-3">
                          <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-foreground">
                            {index + 1}
                          </span>
                          <span className="leading-6">{fix}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                </div>
              </div>

              <ExampleTemplateCard
                copiedTemplate={copiedTemplate}
                onCopyTemplate={onCopyTemplate}
              />
            </div>
          ) : (
            <ExampleTemplateCard copiedTemplate={copiedTemplate} onCopyTemplate={onCopyTemplate} />
          )}
        </div>
      </SearchableSetting>

      {legacyHookEntries.length > 0 ? (
        <SearchableSetting
          title="Legacy Repo-Local Hooks"
          description="Older setup and archive hook scripts stored in local repo settings."
          keywords={['legacy', 'fallback', 'setup', 'archive']}
        >
          <div className="space-y-4 rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1">
                <h5 className="text-sm font-semibold text-amber-700 dark:text-amber-300">
                  Legacy Repo-Local Hooks
                </h5>
                <p className="text-xs text-muted-foreground">
                  These older commands still run as a fallback when `orca.yaml` does not provide a
                  hook. Clear them after you migrate the behavior into `orca.yaml`.
                </p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={onClearLegacyHooks}>
                Clear Legacy Hooks
              </Button>
            </div>

            {legacyHookEntries.map(([hookName, script]) => (
              <div
                key={hookName}
                className="space-y-2 rounded-xl border border-amber-500/20 bg-background/70 p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium capitalize text-foreground">{hookName}</p>
                  <span className="text-[10px] text-muted-foreground">Compatibility fallback</span>
                </div>
                <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-background p-3 font-mono text-[11px] leading-5 text-foreground">
                  {script}
                </pre>
              </div>
            ))}
          </div>
        </SearchableSetting>
      ) : null}

      <SearchableSetting
        title="When to Run Setup"
        description="Choose the default behavior when a setup command is available."
        keywords={['setup run policy', 'ask', 'run by default', 'skip by default']}
      >
        <div className="space-y-3 rounded-2xl border border-border/50 bg-background/80 p-4 shadow-sm">
          <div className="space-y-1">
            <h5 className="text-sm font-semibold">When to Run Setup</h5>
            <p className="text-xs text-muted-foreground">
              Choose the default behavior when a setup command is available.
            </p>
          </div>

          <div className="grid gap-2 md:grid-cols-3">
            {SETUP_RUN_POLICY_OPTIONS.map(({ policy, label, description }) => {
              const selected = selectedSetupRunPolicy === policy

              return (
                <button
                  key={policy}
                  onClick={() => onUpdateSetupRunPolicy(policy)}
                  className={`rounded-xl border px-3 py-2.5 text-center transition-colors ${
                    selected
                      ? 'border-foreground/15 bg-accent text-accent-foreground'
                      : 'border-border/60 bg-background text-foreground hover:border-border hover:bg-muted/40'
                  }`}
                >
                  <span className={`block text-sm ${selected ? 'font-semibold' : 'font-medium'}`}>
                    {label}
                  </span>
                  <p
                    className={`mt-1 text-[11px] leading-4 ${
                      selected ? 'text-accent-foreground/80' : 'text-muted-foreground'
                    }`}
                  >
                    {description}
                  </p>
                </button>
              )
            })}
          </div>
        </div>
      </SearchableSetting>
    </section>
  )
}

const PARSE_ERROR_FIXES = [
  'Check the indentation under `scripts:`. Hook keys should use two spaces, and command lines should use four.',
  'Define only the supported hook keys: `setup` and `archive`.',
  'Compare your file against the working template below and copy that shape if needed.'
]

function renderYamlScriptPreview(yamlHooks: OrcaHooks | null): string {
  return `scripts:${
    yamlHooks?.scripts.setup
      ? `
  setup: |
${yamlHooks.scripts.setup.replace(/^/gm, '    ')}`
      : ''
  }${
    yamlHooks?.scripts.archive
      ? `
  archive: |
${yamlHooks.scripts.archive.replace(/^/gm, '    ')}`
      : ''
  }`
}
