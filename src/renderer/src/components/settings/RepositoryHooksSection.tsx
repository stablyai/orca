import type { OrcaHooks, Repo, SetupRunPolicy } from '../../../../shared/types'
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
                  ? 'The file exists, but Orca could not read valid setup or archive commands from it yet.'
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
            <p className="text-[10px] text-muted-foreground">
              Fix the file format in `orca.yaml` to restore shared hook behavior.
            </p>
          ) : (
            <div className="space-y-2">
              <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                Example `orca.yaml` template
              </p>
              <div className="rounded-lg border border-border/50 bg-background/70">
                <div className="flex items-center justify-end border-b border-border/40 px-2 py-1.5">
                  <Button
                    type="button"
                    variant={copiedTemplate ? 'secondary' : 'ghost'}
                    size="sm"
                    className={`h-6 px-2 text-[11px] ${
                      copiedTemplate
                        ? 'text-foreground'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                    onClick={onCopyTemplate}
                  >
                    {copiedTemplate ? 'Copied' : 'Copy'}
                  </Button>
                </div>
                <pre className="overflow-x-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-5 text-muted-foreground">
                  {EXAMPLE_TEMPLATE}
                </pre>
              </div>
            </div>
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
