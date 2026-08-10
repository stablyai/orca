import { useEffect, useRef } from 'react'
import type { GlobalSettings, Repo } from '../../../../shared/types'
import {
  WORKTREE_CREATE_TIMEOUT_DEFAULTS,
  type WorktreeCreateTimeoutOverrides,
  type WorktreeCreateTimeouts
} from '../../../../shared/worktree-create-timeouts'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { SettingsRow } from './SettingsFormControls'
import { RepoSettingsDraftInput } from './RepositorySettingsDraftInput'
import { SearchableSetting } from './SearchableSetting'
import { translateSearchKeyword } from './settings-search-keywords'

const MIN_TIMEOUT_SECONDS = 1
const MAX_TIMEOUT_SECONDS = 7200
const EMPTY_TIMEOUT_OVERRIDES: WorktreeCreateTimeoutOverrides = {}

type TimeoutField = {
  key: keyof WorktreeCreateTimeouts
}

const TIMEOUT_FIELDS: readonly TimeoutField[] = [
  { key: 'refreshBaseRefMs' },
  { key: 'addCheckoutMs' },
  { key: 'registrationMs' },
  { key: 'materializationMs' }
]

function getTimeoutFieldCopy(key: keyof WorktreeCreateTimeouts): {
  label: string
  description: string
} {
  switch (key) {
    case 'refreshBaseRefMs':
      return {
        label: translate(
          'auto.components.settings.RepositoryWorktreeCreateTimeoutSettings.refreshBaseRefMs.label',
          'Refresh base reference'
        ),
        description: translate(
          'auto.components.settings.RepositoryWorktreeCreateTimeoutSettings.refreshBaseRefMs.description',
          'Fetching the remote base branch before creating the checkout.'
        )
      }
    case 'addCheckoutMs':
      return {
        label: translate(
          'auto.components.settings.RepositoryWorktreeCreateTimeoutSettings.addCheckoutMs.label',
          'Add checkout'
        ),
        description: translate(
          'auto.components.settings.RepositoryWorktreeCreateTimeoutSettings.addCheckoutMs.description',
          'Running git worktree add and creating the checkout.'
        )
      }
    case 'registrationMs':
      return {
        label: translate(
          'auto.components.settings.RepositoryWorktreeCreateTimeoutSettings.registrationMs.label',
          'Workspace registration'
        ),
        description: translate(
          'auto.components.settings.RepositoryWorktreeCreateTimeoutSettings.registrationMs.description',
          'Waiting for the new workspace to appear in Orca.'
        )
      }
    case 'materializationMs':
      return {
        label: translate(
          'auto.components.settings.RepositoryWorktreeCreateTimeoutSettings.materializationMs.label',
          'Workspace materialization'
        ),
        description: translate(
          'auto.components.settings.RepositoryWorktreeCreateTimeoutSettings.materializationMs.description',
          'Waiting for checkout files and workspace metadata to become ready.'
        )
      }
  }
}

type RepositoryWorktreeCreateTimeoutSettingsProps = {
  repo: Repo
  settings: Pick<GlobalSettings, 'worktreeCreateTimeouts'> | null
  updateTimeouts: (worktreeCreateTimeouts: WorktreeCreateTimeoutOverrides | null) => void
  forceVisible: boolean
}

function withoutTimeout(
  timeouts: WorktreeCreateTimeoutOverrides,
  key: keyof WorktreeCreateTimeouts
): WorktreeCreateTimeoutOverrides {
  const next = { ...timeouts }
  delete next[key]
  return next
}

function timeoutOverridesMatch(
  left: WorktreeCreateTimeoutOverrides,
  right: WorktreeCreateTimeoutOverrides
): boolean {
  return TIMEOUT_FIELDS.every((field) => left[field.key] === right[field.key])
}

function formatTimeoutSeconds(timeoutMs: number | undefined): string {
  return timeoutMs === undefined ? '' : String(timeoutMs / 1000)
}

export function RepositoryWorktreeCreateTimeoutSettings({
  repo,
  settings,
  updateTimeouts,
  forceVisible
}: RepositoryWorktreeCreateTimeoutSettingsProps): React.JSX.Element {
  const configuredTimeouts = repo.worktreeCreateTimeouts ?? EMPTY_TIMEOUT_OVERRIDES
  const inheritedTimeouts = settings?.worktreeCreateTimeouts ?? WORKTREE_CREATE_TIMEOUT_DEFAULTS
  const canShowInheritedValue = !getRepoExecutionHostId(repo).startsWith('runtime:')
  const latestTimeoutsRef = useRef<WorktreeCreateTimeoutOverrides>({ ...configuredTimeouts })
  const observedTimeoutsRef = useRef<WorktreeCreateTimeoutOverrides>({ ...configuredTimeouts })
  const pendingTimeoutsRef = useRef<WorktreeCreateTimeoutOverrides[]>([])
  const observedRepoIdRef = useRef(repo.id)

  useEffect(() => {
    if (observedRepoIdRef.current !== repo.id) {
      observedRepoIdRef.current = repo.id
      latestTimeoutsRef.current = configuredTimeouts
      observedTimeoutsRef.current = configuredTimeouts
      pendingTimeoutsRef.current = []
      return
    }
    if (timeoutOverridesMatch(configuredTimeouts, observedTimeoutsRef.current)) {
      return
    }
    observedTimeoutsRef.current = configuredTimeouts
    const pendingIndex = pendingTimeoutsRef.current.findIndex((pendingTimeouts) =>
      timeoutOverridesMatch(pendingTimeouts, configuredTimeouts)
    )
    if (pendingIndex >= 0) {
      pendingTimeoutsRef.current.splice(0, pendingIndex + 1)
      if (pendingTimeoutsRef.current.length === 0) {
        latestTimeoutsRef.current = configuredTimeouts
      }
      return
    }
    pendingTimeoutsRef.current = []
    latestTimeoutsRef.current = configuredTimeouts
  }, [configuredTimeouts, repo.id])

  const updateTimeout = (key: keyof WorktreeCreateTimeouts, text: string): void => {
    const latestTimeouts = latestTimeoutsRef.current
    const trimmed = text.trim()
    if (trimmed === '') {
      if (latestTimeouts[key] === undefined) {
        return
      }
      const nextTimeouts = withoutTimeout(latestTimeouts, key)
      latestTimeoutsRef.current = nextTimeouts
      pendingTimeoutsRef.current.push(nextTimeouts)
      updateTimeouts(Object.keys(nextTimeouts).length > 0 ? nextTimeouts : null)
      return
    }
    const seconds = Number(trimmed)
    if (!Number.isFinite(seconds)) {
      return
    }
    const timeoutMs = Math.round(
      Math.min(MAX_TIMEOUT_SECONDS, Math.max(MIN_TIMEOUT_SECONDS, seconds)) * 1000
    )
    if (latestTimeouts[key] === timeoutMs) {
      return
    }
    const nextTimeouts = { ...latestTimeouts, [key]: timeoutMs }
    latestTimeoutsRef.current = nextTimeouts
    pendingTimeoutsRef.current.push(nextTimeouts)
    updateTimeouts(nextTimeouts)
  }

  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.RepositoryWorktreeCreateTimeoutSettings.title',
        'Worktree Creation Timeouts'
      )}
      description={translate(
        'auto.components.settings.RepositoryWorktreeCreateTimeoutSettings.description',
        'Override worktree creation stage timeouts for this project.'
      )}
      keywords={[
        repo.displayName,
        ...translateSearchKeyword(
          'auto.components.settings.RepositoryWorktreeCreateTimeoutSettings.keyword.advanced',
          'advanced'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.RepositoryWorktreeCreateTimeoutSettings.keyword.timeout',
          'timeout'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.RepositoryWorktreeCreateTimeoutSettings.keyword.seconds',
          'seconds'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.RepositoryWorktreeCreateTimeoutSettings.keyword.slowNetwork',
          'slow network'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.RepositoryWorktreeCreateTimeoutSettings.keyword.gitWorktreeAdd',
          'git worktree add'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.RepositoryWorktreeCreateTimeoutSettings.keyword.registration',
          'registration'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.RepositoryWorktreeCreateTimeoutSettings.keyword.materialization',
          'materialization'
        )
      ]}
      forceVisible={forceVisible}
    >
      <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-3">
        <div className="flex items-start justify-between gap-3 pb-1">
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.RepositoryWorktreeCreateTimeoutSettings.inheritance',
              'Leave a field empty to inherit the global setting on the execution host.'
            )}
          </p>
          {repo.worktreeCreateTimeouts ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                latestTimeoutsRef.current = {}
                pendingTimeoutsRef.current.push({})
                updateTimeouts(null)
              }}
            >
              {translate(
                'auto.components.settings.RepositoryWorktreeCreateTimeoutSettings.useGlobal',
                'Use Global'
              )}
            </Button>
          ) : null}
        </div>
        <div className="divide-y divide-border/50">
          {TIMEOUT_FIELDS.map((field) => {
            const copy = getTimeoutFieldCopy(field.key)
            return (
              <SettingsRow
                key={field.key}
                label={copy.label}
                description={copy.description}
                control={
                  <div className="flex items-center gap-2">
                    <RepoSettingsDraftInput
                      repoId={`${repo.id}:${field.key}`}
                      storeValue={formatTimeoutSeconds(configuredTimeouts[field.key])}
                      type="number"
                      min={MIN_TIMEOUT_SECONDS}
                      max={MAX_TIMEOUT_SECONDS}
                      step={1}
                      placeholder={
                        canShowInheritedValue
                          ? String(
                              (inheritedTimeouts[field.key] ??
                                WORKTREE_CREATE_TIMEOUT_DEFAULTS[field.key]) / 1000
                            )
                          : translate(
                              'auto.components.settings.RepositoryWorktreeCreateTimeoutSettings.hostDefault',
                              'Host default'
                            )
                      }
                      onTextChange={() => {}}
                      onBlur={(event) => updateTimeout(field.key, event.currentTarget.value)}
                      className="number-input-clean w-24 tabular-nums"
                    />
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {translate(
                        'auto.components.settings.RepositoryWorktreeCreateTimeoutSettings.seconds',
                        'seconds'
                      )}
                    </span>
                  </div>
                }
              />
            )
          })}
        </div>
      </div>
    </SearchableSetting>
  )
}
