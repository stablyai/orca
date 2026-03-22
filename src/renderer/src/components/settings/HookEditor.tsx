import type { OrcaHooks, Repo } from '../../../../shared/types'
import { Label } from '../ui/label'
import type { HookName } from './SettingsConstants'

export function HookEditor({
  hookName,
  repo,
  yamlHooks,
  onScriptChange
}: {
  hookName: HookName
  repo: Repo
  yamlHooks: OrcaHooks | null
  onScriptChange: (script: string) => void
}): React.JSX.Element {
  const uiScript = repo.hookSettings?.scripts[hookName] ?? ''
  const yamlScript = yamlHooks?.scripts[hookName]
  const effectiveSource =
    repo.hookSettings?.mode === 'auto' && yamlScript ? 'yaml' : uiScript.trim() ? 'ui' : 'none'

  return (
    <div className="space-y-3 rounded-2xl border bg-background/80 p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h5 className="text-sm font-semibold capitalize">{hookName}</h5>
          <p className="text-xs text-muted-foreground">
            {hookName === 'setup'
              ? 'Runs after a worktree is created.'
              : 'Runs before a worktree is archived.'}
          </p>
        </div>

        <span
          className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] ${
            effectiveSource === 'yaml'
              ? 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
              : effectiveSource === 'ui'
                ? 'border border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300'
                : 'border bg-muted text-muted-foreground'
          }`}
        >
          {effectiveSource === 'yaml'
            ? 'Honoring YAML'
            : effectiveSource === 'ui'
              ? 'Using UI'
              : 'Inactive'}
        </span>
      </div>

      {yamlScript && (
        <div className="space-y-2 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3">
          <div className="flex items-center justify-between gap-2">
            <Label className="text-xs font-medium uppercase tracking-[0.18em] text-emerald-700 dark:text-emerald-300">
              YAML Script
            </Label>
            <span className="text-[10px] text-muted-foreground">Read-only from `orca.yaml`</span>
          </div>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-background/70 p-3 font-mono text-[11px] leading-5 text-foreground">
            {yamlScript}
          </pre>
        </div>
      )}

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Label className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            UI Script
          </Label>
          <span className="text-[10px] text-muted-foreground">
            {repo.hookSettings?.mode === 'auto' && yamlScript
              ? 'Stored as fallback until you switch to override.'
              : 'Editable script stored with this repo.'}
          </span>
        </div>
        <textarea
          value={uiScript}
          onChange={(e) => onScriptChange(e.target.value)}
          placeholder={
            hookName === 'setup'
              ? 'pnpm install\npnpm generate'
              : 'echo "Cleaning up before archive"'
          }
          spellCheck={false}
          className="min-h-[12rem] w-full resize-y rounded-xl border bg-background px-3 py-3 font-mono text-[12px] leading-5 outline-none transition-colors placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
        />
      </div>
    </div>
  )
}
