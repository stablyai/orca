import React, { useMemo, useState } from 'react'
import {
  useRepoLabelsBySlug,
  useRepoAssigneesBySlug
} from '@/lib/work-items/github/useGitHubSlugMetadata'
import type { PickerOption } from '@/components/github/PRFilterPickers'
import type { PRFilterChange } from '@/components/github/PRFilterSections'
import { TaskFilterMenu } from '@/components/task-page/TaskFilterMenu'
import type { GitHubAssignableUser } from '../../../../shared/github/pull-requests/pull-request-types'
import type { GitHubRepositoryIdentity as GitHubOwnerRepo } from '../../../../shared/github/repositories/repository-identity'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { ParsedTaskQuery } from '../../../../shared/work-items/task-query'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

type Props = {
  parsed: ParsedTaskQuery
  kind: 'prs' | 'issues'
  authorLogins: string[]
  // Scope metadata to the first selected repo; one popover cannot enumerate every repo’s labels and users.
  primarySlug: GitHubOwnerRepo | null
  /** Host that owns the repo the primary slug came from. */
  ownerTarget?: RuntimeClientTarget | null
  onChange: (change: PRFilterChange) => void
}

export type { PRFilterChange } from '@/components/github/PRFilterSections'

function currentUserLabel(t: Translate = translate): string {
  return t('auto.components.github.PRFilterDropdowns.currentUser', 'Current user')
}

function userOptions(users: GitHubAssignableUser[]): PickerOption[] {
  return users.map((u) => ({ key: u.login, primary: u.login, secondary: u.name ?? undefined }))
}

export default function PRFilterDropdowns({
  parsed,
  kind,
  authorLogins,
  primarySlug,
  ownerTarget,
  onChange
}: Props): React.JSX.Element {
  const [popoverOpen, setPopoverOpen] = useState(false)
  // Each author pick reloads the list, so keep the authors visible at open as candidates.
  const [authorLoginsAtOpen, setAuthorLoginsAtOpen] = useState<string[]>([])
  const owner = primarySlug?.owner ?? null
  const repo = primarySlug?.repo ?? null
  const hasPrimarySlug = popoverOpen && owner !== null && repo !== null
  const labelsState = useRepoLabelsBySlug(
    popoverOpen ? owner : null,
    popoverOpen ? repo : null,
    ownerTarget,
    primarySlug?.host
  )
  const assigneesState = useRepoAssigneesBySlug(
    popoverOpen ? owner : null,
    popoverOpen ? repo : null,
    undefined,
    ownerTarget,
    primarySlug?.host
  )

  // Offer @me because GitHub resolves it server-side to the authenticated user.
  const userOpts = useMemo<PickerOption[]>(() => {
    const meOption: PickerOption = {
      key: '@me',
      primary: '@me',
      secondary: currentUserLabel()
    }
    return [meOption, ...userOptions(hasPrimarySlug ? assigneesState.data : [])]
  }, [assigneesState.data, hasPrimarySlug])
  const authorOpts = useMemo<PickerOption[]>(() => {
    const options = new Map<string, PickerOption>()
    options.set('@me', {
      key: '@me',
      primary: '@me',
      secondary: currentUserLabel()
    })
    // Use visible authors because assignable-user metadata excludes outside contributors.
    for (const login of [...authorLoginsAtOpen, ...authorLogins]) {
      options.set(login.toLowerCase(), { key: login, primary: login })
    }
    // Key options by the query's casing so the picker's selection matches them.
    for (const author of parsed.authors) {
      const lower = author.toLowerCase()
      options.set(lower, { ...(options.get(lower) ?? { primary: author }), key: author })
    }
    return [...options.values()]
  }, [authorLoginsAtOpen, authorLogins, parsed.authors])
  const labelOpts = useMemo<PickerOption[]>(
    () => (hasPrimarySlug ? labelsState.data.map((name) => ({ key: name, primary: name })) : []),
    [hasPrimarySlug, labelsState.data]
  )

  return (
    <TaskFilterMenu
      parsed={parsed}
      kind={kind}
      open={popoverOpen}
      onOpenChange={(next) => {
        setPopoverOpen(next)
        if (next) {
          setAuthorLoginsAtOpen(authorLogins)
        }
      }}
      authorOpts={authorOpts}
      userOpts={userOpts}
      labelOpts={labelOpts}
      labelsLoading={hasPrimarySlug && labelsState.loading}
      labelsError={hasPrimarySlug ? labelsState.error : null}
      usersLoading={hasPrimarySlug && assigneesState.loading}
      usersError={hasPrimarySlug ? assigneesState.error : null}
      onChange={onChange}
    />
  )
}
