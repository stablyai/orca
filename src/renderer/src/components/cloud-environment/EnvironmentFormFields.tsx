import { useId, useRef, useState } from 'react'
import { GitBranch, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { useTranslate } from '@/i18n/use-translate'
import { normalizeRepoInput, repoDisplayName, repoKey } from './cloud-environment-copy'
import type { EnvironmentDraft } from './cloud-environment-types'
import { MAX_INSTALL_SCRIPT_CHARS } from './environment-draft'

export type LocalRepoSuggestion = {
  /** Orca project id. */
  repoId: string
  /** `owner/repo` from the project's GitHub remote. */
  slug: string
  path: string
  displayName: string
}

export function FieldLabel({
  htmlFor,
  id,
  children,
  hint
}: {
  htmlFor?: string
  id?: string
  children: React.ReactNode
  hint?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="space-y-0.5">
      <label htmlFor={htmlFor} id={id} className="text-sm font-medium">
        {children}
      </label>
      {hint ? <p className="text-xs leading-5 text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

export function RepoListEditor({
  repos,
  onChange,
  suggestions
}: {
  repos: EnvironmentDraft['repos']
  onChange: (repos: EnvironmentDraft['repos']) => void
  suggestions: readonly LocalRepoSuggestion[]
}): React.JSX.Element {
  const t = useTranslate()
  const inputId = useId()
  const labelId = useId()
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const present = new Set(repos.map((repo) => repoKey(repo.url)))
  const offered = suggestions.filter((suggestion) => !present.has(suggestion.slug.toLowerCase()))

  const add = (raw: string): boolean => {
    const slug = normalizeRepoInput(raw)
    if (!slug) {
      setError(
        t(
          'cloudEnvironment.form.repoInvalid',
          'Enter a GitHub repository as owner/repo or a github.com URL.'
        )
      )
      return false
    }
    if (present.has(slug.toLowerCase())) {
      setError(
        t('cloudEnvironment.form.repoDuplicate', '{{repo}} is already listed.', { repo: slug })
      )
      return false
    }
    setError(null)
    onChange([...repos, { url: slug, defaultBranch: null }])
    return true
  }

  const submit = (): void => {
    if (add(value)) {
      setValue('')
    }
  }

  return (
    <div className="space-y-2" role="group" aria-labelledby={labelId}>
      <FieldLabel
        id={labelId}
        htmlFor={inputId}
        hint={t(
          'cloudEnvironment.form.reposHint',
          'Cloned into every workspace. The install script runs in the first one.'
        )}
      >
        {t('cloudEnvironment.form.repos', 'Repositories')}
      </FieldLabel>
      {repos.length > 0 ? (
        <ul className="divide-y divide-border/60 rounded-md border border-border">
          {repos.map((repo, index) => {
            const name = repoDisplayName(repo.url)
            return (
              <li key={repoKey(repo.url)} className="flex items-center gap-2 px-3 py-1.5">
                <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{name}</span>
                {index === 0 && repos.length > 1 ? (
                  <span className="text-[11px] text-muted-foreground">
                    {t('cloudEnvironment.form.primaryRepo', 'install script runs here')}
                  </span>
                ) : null}
                <div className="relative w-40">
                  <GitBranch
                    aria-hidden
                    className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
                  />
                  <Input
                    value={repo.defaultBranch ?? ''}
                    placeholder={t('cloudEnvironment.form.branchPlaceholder', 'default branch')}
                    aria-label={t('cloudEnvironment.form.branchAria', 'Branch for {{repo}}', {
                      repo: name
                    })}
                    className="h-7 pl-7 font-mono text-xs md:text-xs"
                    onChange={(event) => {
                      const next = [...repos]
                      next[index] = {
                        ...repo,
                        defaultBranch: event.target.value
                      }
                      onChange(next)
                    }}
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t('cloudEnvironment.form.removeRepo', 'Remove {{repo}}', {
                    repo: name
                  })}
                  onClick={() => onChange(repos.filter((_, i) => i !== index))}
                >
                  <X />
                </Button>
              </li>
            )
          })}
        </ul>
      ) : null}
      <div className="flex gap-2">
        <Input
          id={inputId}
          value={value}
          onChange={(event) => {
            setValue(event.target.value)
            setError(null)
          }}
          placeholder={t(
            'cloudEnvironment.form.repoPlaceholder',
            'owner/repo or https://github.com/…'
          )}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${inputId}-error` : undefined}
          className="h-8 font-mono text-[13px] md:text-[13px]"
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              submit()
            }
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={value.trim() === ''}
          onClick={submit}
        >
          <Plus />
          {t('cloudEnvironment.form.addRepo', 'Add')}
        </Button>
      </div>
      {error ? (
        <p id={`${inputId}-error`} className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {offered.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">
            {t('cloudEnvironment.form.fromProjects', 'From your projects:')}
          </span>
          {offered.slice(0, 8).map((suggestion) => (
            <Button
              key={suggestion.repoId}
              type="button"
              variant="outline"
              size="xs"
              className="font-mono"
              onClick={() => add(suggestion.slug)}
              aria-label={t('cloudEnvironment.form.addSuggestion', 'Add {{repo}}', {
                repo: suggestion.slug
              })}
            >
              <Plus />
              {suggestion.slug}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** Textarea with a synced line-number gutter; a full editor is overkill for a setup script. */
export function InstallScriptEditor({
  value,
  onChange,
  readOnly = false,
  id
}: {
  value: string
  onChange?: (value: string) => void
  readOnly?: boolean
  id?: string
}): React.JSX.Element {
  const t = useTranslate()
  const gutterRef = useRef<HTMLDivElement | null>(null)
  const escaped = useRef(false)
  const tabHintId = useId()
  const lineCount = Math.max(1, value.split('\n').length)
  const tooLong = value.length > MAX_INSTALL_SCRIPT_CHARS
  return (
    <div className="space-y-1">
      <div
        className={cn(
          'flex overflow-hidden rounded-md bg-muted/30 font-mono text-xs leading-5 dark:bg-black/20',
          readOnly
            ? 'border border-transparent'
            : cn(
                'border border-input',
                'focus-within:border-focus-ring focus-within:ring-1 focus-within:ring-focus-ring'
              ),
          tooLong && 'border-destructive'
        )}
      >
        <div
          ref={gutterRef}
          aria-hidden
          className="max-h-80 shrink-0 overflow-hidden border-r border-border/60 px-2 py-2 text-right text-muted-foreground tabular-nums select-none"
        >
          {Array.from({ length: lineCount }, (_, index) => (
            <div key={index}>{index + 1}</div>
          ))}
        </div>
        <textarea
          id={id}
          value={value}
          readOnly={readOnly}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrap="off"
          rows={readOnly ? Math.min(16, lineCount) : Math.min(16, Math.max(6, lineCount))}
          placeholder={
            readOnly
              ? undefined
              : t(
                  'cloudEnvironment.form.scriptPlaceholder',
                  'corepack enable\npnpm install --frozen-lockfile'
                )
          }
          onScroll={(event) => {
            if (gutterRef.current) {
              gutterRef.current.scrollTop = event.currentTarget.scrollTop
            }
          }}
          aria-describedby={readOnly ? undefined : tabHintId}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              // Escape, then Tab, leaves the field (the usual code-editor escape hatch).
              escaped.current = true
              return
            }
            const leaving = escaped.current
            escaped.current = false
            // Tab indents; Shift+Tab, or Tab right after Escape, moves focus as usual.
            if (event.key === 'Tab' && !event.shiftKey && !leaving && !readOnly && onChange) {
              event.preventDefault()
              // insertText keeps the edit on the native undo stack (Cmd+Z undoes the indent).
              if (!document.execCommand('insertText', false, '  ')) {
                const target = event.currentTarget
                const { selectionStart, selectionEnd } = target
                onChange(`${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`)
              }
            }
          }}
          onChange={(event) => onChange?.(event.target.value)}
          className={cn(
            'max-h-80 min-w-0 flex-1 bg-transparent px-3 py-2 whitespace-pre outline-none placeholder:text-muted-foreground/50',
            readOnly ? 'resize-none' : 'resize-y'
          )}
        />
      </div>
      {readOnly ? null : (
        <span id={tabHintId} className="sr-only">
          {t(
            'cloudEnvironment.form.scriptTabHint',
            'Tab inserts two spaces. Press Escape, then Tab, to leave the editor.'
          )}
        </span>
      )}
      <div className="flex justify-between gap-2 text-[11px] text-muted-foreground">
        <span>
          {t(
            'cloudEnvironment.form.scriptRuntimeStops',
            'Runs once per build in the first repository and stops at the first failing command. Passwordless sudo (Ubuntu, apt-get).'
          )}
        </span>
        <span
          className={cn(
            'shrink-0 tabular-nums',
            tooLong && 'text-destructive',
            readOnly && 'hidden'
          )}
        >
          {value.length.toLocaleString()} / {MAX_INSTALL_SCRIPT_CHARS.toLocaleString()}
        </span>
      </div>
    </div>
  )
}
