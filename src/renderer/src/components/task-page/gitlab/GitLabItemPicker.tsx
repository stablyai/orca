import { useEffect, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { useTranslate } from '@/i18n/use-translate'
import { gitLabApiFor } from '@/runtime/repository-gitlab/gitlab-owner-api'
import type {
  GitLabAssignableUser,
  GitLabProjectRef,
  GitLabWorkItem,
  GitLabWorkItemDetails
} from '../../../../../shared/gitlab/gitlab-types'
import type { GitLabDialogRepoSelector } from '../../gitlab-item-dialog/gitlab-item-dialog-types'

export type GitLabRowSelector = GitLabDialogRepoSelector & { projectRef: GitLabProjectRef }
export type PickerKind = 'labels' | 'assignees' | 'reviewers'
type PickerOption = { key: string; label: string; name?: string | null }
type PickerData = { options: PickerOption[]; current: string[] }
export type MutationResult = { ok: true } | { ok: false; error: string }

function userOption(user: GitLabAssignableUser): PickerOption {
  return { key: user.username, label: user.username, name: user.name }
}

function matchesPickerItem(
  details: GitLabWorkItemDetails,
  selector: GitLabRowSelector,
  item: GitLabWorkItem
): boolean {
  // Issue list IDs are repo-scoped, while the detail endpoint returns the provider ID.
  return (
    details.item.type === item.type &&
    details.item.number === item.number &&
    details.item.projectRef?.host === selector.projectRef.host &&
    details.item.projectRef.path === selector.projectRef.path
  )
}

async function readPicker(
  selector: GitLabRowSelector,
  item: GitLabWorkItem,
  kind: PickerKind
): Promise<PickerData | null> {
  const api = gitLabApiFor(selector)
  const [details, available] = await Promise.all([
    api.workItemDetails({
      ...selector,
      iid: item.number,
      type: item.type,
      includeReviewDetails: kind === 'reviewers'
    }),
    kind === 'labels' ? api.listLabels(selector) : api.listAssignableUsers(selector)
  ])
  if (!details || !matchesPickerItem(details, selector, item)) {
    return null
  }
  if (kind === 'labels') {
    const current = details.item.labels
    const labels = available.filter((value): value is string => typeof value === 'string')
    return {
      current,
      options: [...new Set([...current, ...labels])].map((label) => ({ key: label, label }))
    }
  }
  const users = available.filter(
    (value): value is GitLabAssignableUser => typeof value !== 'string'
  )
  if (kind === 'assignees') {
    if (!details.assignees) {
      return null
    }
    const named = new Map(users.map((user) => [user.username, userOption(user)]))
    for (const username of details.assignees) {
      if (!named.has(username)) {
        named.set(username, { key: username, label: username })
      }
    }
    return { options: [...named.values()], current: details.assignees }
  }
  if (!details.reviewers || details.reviewers.some((user) => typeof user.id !== 'number')) {
    return null
  }
  const byId = new Map<number, PickerOption>()
  for (const user of [...users, ...details.reviewers]) {
    if (typeof user.id === 'number') {
      byId.set(user.id, { ...userOption(user), key: String(user.id) })
    }
  }
  return { options: [...byId.values()], current: details.reviewers.map((user) => String(user.id)) }
}

export function GitLabItemPicker({
  selector,
  item,
  kind,
  busy,
  runMutation
}: {
  selector: GitLabRowSelector
  item: GitLabWorkItem
  kind: PickerKind
  busy: boolean
  runMutation: (mutate: () => Promise<MutationResult>) => Promise<void>
}): React.JSX.Element {
  const t = useTranslate()
  const [load, setLoad] = useState<{
    selector: GitLabRowSelector
    item: GitLabWorkItem
    data: PickerData | null
    error: string | null
  } | null>(null)
  const [draft, setDraft] = useState<string[]>([])
  const [query, setQuery] = useState('')
  useEffect(() => {
    let stale = false
    void readPicker(selector, item, kind)
      .then((result) => {
        if (stale) {
          return
        }
        if (result) {
          setLoad({ selector, item, data: result, error: null })
          setDraft(result.current)
        } else {
          setLoad({
            selector,
            item,
            data: null,
            error: t(
              'auto.components.GitLabItemDialog.itemLoadFailed',
              'Could not load this item. Refresh to try again.'
            )
          })
        }
      })
      .catch((err: unknown) => {
        if (!stale) {
          setLoad({
            selector,
            item,
            data: null,
            error: err instanceof Error ? err.message : String(err)
          })
        }
      })
    return () => {
      stale = true
    }
  }, [selector, item, kind, t])
  const currentLoad = load?.selector === selector && load.item === item ? load : null
  const data = currentLoad?.data
  const error = currentLoad?.error
  if (error) {
    return <p className="px-2 py-2 text-xs text-destructive">{error}</p>
  }
  if (!data) {
    return (
      <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
        <LoaderCircle className="size-3 animate-spin" />
        {t('auto.components.TaskPage.0eacf48491', 'Loading…')}
      </div>
    )
  }
  const added = draft.filter((key) => !data.current.includes(key))
  const removed = data.current.filter((key) => !draft.includes(key))
  const filtered = data.options.filter((option) =>
    `${option.label} ${option.name ?? ''}`.toLowerCase().includes(query.trim().toLowerCase())
  )
  const submit = (): void => {
    void runMutation(async () => {
      const api = gitLabApiFor(selector)
      if (kind === 'reviewers') {
        // Reviewers are a replacement write: preserve changes made since the picker was opened.
        const latest = await api.workItemDetails({
          ...selector,
          iid: item.number,
          type: 'mr',
          includeReviewDetails: true
        })
        if (
          !latest ||
          !matchesPickerItem(latest, selector, item) ||
          !latest.reviewers ||
          latest.reviewers.some((user) => typeof user.id !== 'number')
        ) {
          return {
            ok: false,
            error: t(
              'auto.components.GitLabItemDialog.itemLoadFailed',
              'Could not load this item. Refresh to try again.'
            )
          }
        }
        const reviewerIds = [
          ...new Set([
            ...latest.reviewers
              .map((user) => String(user.id))
              .filter((key) => !removed.includes(key)),
            ...added
          ])
        ].map(Number)
        return api.updateMRReviewers({
          ...selector,
          iid: item.number,
          reviewerIds
        })
      }
      if (kind === 'assignees') {
        return api.updateIssue({
          ...selector,
          number: item.number,
          updates: { addAssignees: added, removeAssignees: removed }
        })
      }
      const updates = { addLabels: added, removeLabels: removed }
      return item.type === 'mr'
        ? api.updateMR({ ...selector, iid: item.number, updates })
        : api.updateIssue({ ...selector, number: item.number, updates })
    })
  }
  const searchLabel = t('auto.components.TerminalSearch.e07012f26e', 'Search...')
  return (
    <div className="flex flex-col gap-2 p-2">
      <Input
        density="compact"
        aria-label={searchLabel}
        placeholder={searchLabel}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        disabled={busy}
      />
      <div className="max-h-52 overflow-y-auto scrollbar-sleek">
        {filtered.length === 0 ? (
          <p className="py-2 text-center text-xs text-muted-foreground">
            {t('auto.components.TerminalSearch.10e039b591', 'No results')}
          </p>
        ) : null}
        {filtered.map((option) => (
          <label
            key={option.key}
            className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-accent"
          >
            <Checkbox
              checked={draft.includes(option.key)}
              disabled={busy}
              onCheckedChange={(checked) =>
                setDraft((current) =>
                  checked
                    ? [...new Set([...current, option.key])]
                    : current.filter((key) => key !== option.key)
                )
              }
              aria-label={option.label}
            />
            <span className="min-w-0">
              <span className="block truncate">{option.label}</span>
              {option.name && option.name !== option.label ? (
                <span className="block truncate text-2xs text-muted-foreground">{option.name}</span>
              ) : null}
            </span>
          </label>
        ))}
      </div>
      <Button
        size="sm"
        disabled={busy || (added.length === 0 && removed.length === 0)}
        onClick={submit}
      >
        {busy ? <LoaderCircle className="size-3 animate-spin" /> : null}
        {t('auto.components.GitLabItemDialog.93f79a3fc1', 'Save')}
      </Button>
    </div>
  )
}
