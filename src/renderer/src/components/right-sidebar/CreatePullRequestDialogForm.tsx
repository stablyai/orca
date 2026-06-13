import { Check, ChevronsUpDown } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { stripBaseRef } from './useCreatePullRequestDialogFields'
import type { CreatePullRequestReviewCopy } from './create-pull-request-review-copy'
import { translate } from '@/i18n/i18n'

type CreatePullRequestDialogFormProps = {
  branch: string
  base: string
  setBase: (value: string) => void
  baseQuery: string
  setBaseQuery: (value: string) => void
  baseResults: string[]
  setBaseResults: (value: string[]) => void
  baseSearchError: string | null
  title: string
  setTitle: (value: string) => void
  body: string
  setBody: (value: string) => void
  draft: boolean
  setDraft: (value: boolean) => void
  copy: CreatePullRequestReviewCopy
  generateError: string | null
  error: string | null
}

export function CreatePullRequestDialogForm({
  branch,
  base,
  setBase,
  baseQuery,
  setBaseQuery,
  baseResults,
  setBaseResults,
  baseSearchError,
  title,
  setTitle,
  body,
  setBody,
  draft,
  setDraft,
  copy,
  generateError,
  error
}: CreatePullRequestDialogFormProps): React.JSX.Element {
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label>
          {translate(
            'auto.components.right.sidebar.CreatePullRequestDialog.6f5f1962b6',
            'Head branch'
          )}
        </Label>
        <div className="inline-flex max-w-full items-center rounded-full border border-border bg-muted px-2 py-1 text-xs font-medium text-foreground">
          <span className="truncate">{branch}</span>
        </div>
      </div>

      <div className="space-y-2">
        <div className="space-y-1">
          <Label htmlFor="create-pr-base">
            {translate(
              'auto.components.right.sidebar.CreatePullRequestDialog.8584ccb43c',
              'Base branch'
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.right.sidebar.CreatePullRequestDialog.0fad57a14c',
              'Search remote branches or enter a branch name.'
            )}
          </p>
        </div>
        <div className="relative">
          <Input
            id="create-pr-base"
            value={baseQuery || base}
            onChange={(event) => {
              setBaseQuery(event.target.value)
              setBase(event.target.value)
            }}
            placeholder={translate(
              'auto.components.right.sidebar.CreatePullRequestDialog.694550a610',
              'main'
            )}
            aria-invalid={!base.trim()}
            className="pr-8"
          />
          <ChevronsUpDown className="pointer-events-none absolute right-2 top-2.5 size-3.5 text-muted-foreground" />
        </div>
        {baseSearchError ? <p className="text-xs text-destructive">{baseSearchError}</p> : null}
        {baseResults.length > 0 ? (
          <div className="max-h-36 overflow-auto rounded-md border border-border p-1 scrollbar-sleek">
            {baseResults.map((ref) => (
              <button
                key={ref}
                type="button"
                className={cn(
                  'flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent',
                  stripBaseRef(base) === ref && 'bg-accent text-accent-foreground'
                )}
                onClick={() => {
                  setBase(ref)
                  setBaseQuery('')
                  setBaseResults([])
                }}
              >
                <span className="truncate">{ref}</span>
                {stripBaseRef(base) === ref ? <Check className="size-3" /> : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="create-pr-title">
          {translate('auto.components.right.sidebar.CreatePullRequestDialog.68314b4369', 'Title')}
        </Label>
        <Input
          id="create-pr-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={translate(
            'auto.components.right.sidebar.CreatePullRequestDialog.68314b4369',
            'Title'
          )}
          aria-invalid={!title.trim()}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="create-pr-body">
          {translate(
            'auto.components.right.sidebar.CreatePullRequestDialog.1cd53359db',
            'Description'
          )}
        </Label>
        <textarea
          id="create-pr-body"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={6}
          placeholder={translate(
            'auto.components.right.sidebar.CreatePullRequestDialog.02b2ce911f',
            'Description (optional)'
          )}
          className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-1 focus-visible:ring-ring"
        />
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.right.sidebar.CreatePullRequestDialog.0c9f9a568c',
            'Supports Markdown formatting. Use Generate with AI to auto-fill from your changes.'
          )}
        </p>
      </div>

      <label className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground transition-colors hover:bg-accent hover:text-accent-foreground">
        <input
          type="checkbox"
          checked={draft}
          onChange={(event) => setDraft(event.target.checked)}
          className="size-4 shrink-0 rounded border-border accent-primary"
        />
        <span className="min-w-0 flex-1 truncate">
          {translate(
            'auto.components.right.sidebar.CreatePullRequestDialog.7ef56f3efe',
            'Create as draft'
          )}
        </span>
      </label>

      {stripBaseRef(base).toLowerCase() === stripBaseRef(branch).toLowerCase() ? (
        <p className="text-xs text-destructive">
          {translate(
            'auto.components.right.sidebar.CreatePullRequestDialog.27ef4b195c',
            'Choose a different base branch before creating a {{value0}}.',
            { value0: copy.reviewLabel }
          )}
        </p>
      ) : null}
      {generateError ? <p className="text-xs text-destructive">{generateError}</p> : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  )
}
