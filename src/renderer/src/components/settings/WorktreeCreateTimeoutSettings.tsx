import { useEffect, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/types'
import {
  WORKTREE_CREATE_TIMEOUT_DEFAULTS,
  type WorktreeCreateTimeouts
} from '../../../../shared/worktree-create-timeouts'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { NumberField, SettingsBadge } from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import {
  matchesSettingsSearch,
  normalizeSettingsSearchQuery,
  type SettingsSearchEntry
} from './settings-search'
import { translateSearchKeyword } from './settings-search-keywords'

const MIN_TIMEOUT_SECONDS = 1
const MAX_TIMEOUT_SECONDS = 7200

type TimeoutField = {
  key: keyof WorktreeCreateTimeouts
  label: string
  description: string
}

function timeoutValuesMatch(left: WorktreeCreateTimeouts, right: WorktreeCreateTimeouts): boolean {
  return (
    left.refreshBaseRefMs === right.refreshBaseRefMs &&
    left.addCheckoutMs === right.addCheckoutMs &&
    left.registrationMs === right.registrationMs &&
    left.materializationMs === right.materializationMs
  )
}

function getTimeoutFields(): readonly TimeoutField[] {
  return [
    {
      key: 'refreshBaseRefMs',
      label: translate(
        'auto.components.settings.WorktreeCreateTimeoutSettings.refreshBaseRefMs.label',
        'Refresh base reference'
      ),
      description: translate(
        'auto.components.settings.WorktreeCreateTimeoutSettings.refreshBaseRefMs.description',
        'Fetching the remote base branch before creating the checkout.'
      )
    },
    {
      key: 'addCheckoutMs',
      label: translate(
        'auto.components.settings.WorktreeCreateTimeoutSettings.addCheckoutMs.label',
        'Add checkout'
      ),
      description: translate(
        'auto.components.settings.WorktreeCreateTimeoutSettings.addCheckoutMs.description',
        'Running git worktree add and creating the checkout.'
      )
    },
    {
      key: 'registrationMs',
      label: translate(
        'auto.components.settings.WorktreeCreateTimeoutSettings.registrationMs.label',
        'Workspace registration'
      ),
      description: translate(
        'auto.components.settings.WorktreeCreateTimeoutSettings.registrationMs.description',
        'Waiting for the new workspace to appear in Orca.'
      )
    },
    {
      key: 'materializationMs',
      label: translate(
        'auto.components.settings.WorktreeCreateTimeoutSettings.materializationMs.label',
        'Workspace materialization'
      ),
      description: translate(
        'auto.components.settings.WorktreeCreateTimeoutSettings.materializationMs.description',
        'Waiting for checkout files and workspace metadata to become ready.'
      )
    }
  ]
}

export function getWorktreeCreateTimeoutSearchEntry(): SettingsSearchEntry {
  return {
    title: translate(
      'auto.components.settings.WorktreeCreateTimeoutSettings.title',
      'Worktree Creation Timeouts'
    ),
    description: translate(
      'auto.components.settings.WorktreeCreateTimeoutSettings.description',
      'Set how long Orca waits for each worktree creation stage before reporting a timeout.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.WorktreeCreateTimeoutSettings.keyword.advanced',
        'advanced'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.WorktreeCreateTimeoutSettings.keyword.timeout',
        'timeout'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.WorktreeCreateTimeoutSettings.keyword.seconds',
        'seconds'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.WorktreeCreateTimeoutSettings.keyword.slowNetwork',
        'slow network'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.WorktreeCreateTimeoutSettings.keyword.remoteHost',
        'remote host'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.WorktreeCreateTimeoutSettings.keyword.refreshBase',
        'refresh base'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.WorktreeCreateTimeoutSettings.keyword.gitWorktreeAdd',
        'git worktree add'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.WorktreeCreateTimeoutSettings.keyword.registration',
        'registration'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.WorktreeCreateTimeoutSettings.keyword.materialization',
        'materialization'
      )
    ]
  }
}

export function shouldOpenWorktreeCreateTimeouts(searchQuery: string): boolean {
  return (
    normalizeSettingsSearchQuery(searchQuery) !== '' &&
    matchesSettingsSearch(searchQuery, getWorktreeCreateTimeoutSearchEntry())
  )
}

type WorktreeCreateTimeoutSettingsProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
  searchQuery: string
}

export function WorktreeCreateTimeoutSettings({
  settings,
  updateSettings,
  searchQuery
}: WorktreeCreateTimeoutSettingsProps): React.JSX.Element | null {
  const searchEntry = getWorktreeCreateTimeoutSearchEntry()
  const matchesSearch = matchesSettingsSearch(searchQuery, searchEntry)
  const forcedOpen = shouldOpenWorktreeCreateTimeouts(searchQuery)
  const [open, setOpen] = useState(false)
  const configuredTimeouts = settings.worktreeCreateTimeouts ?? WORKTREE_CREATE_TIMEOUT_DEFAULTS
  const latestTimeoutsRef = useRef<WorktreeCreateTimeouts>({ ...configuredTimeouts })
  const observedTimeoutsRef = useRef<WorktreeCreateTimeouts>({ ...configuredTimeouts })
  const pendingTimeoutsRef = useRef<WorktreeCreateTimeouts[]>([])

  useEffect(() => {
    const incomingTimeouts = settings.worktreeCreateTimeouts ?? WORKTREE_CREATE_TIMEOUT_DEFAULTS
    if (timeoutValuesMatch(incomingTimeouts, observedTimeoutsRef.current)) {
      return
    }
    observedTimeoutsRef.current = incomingTimeouts
    const pendingIndex = pendingTimeoutsRef.current.findIndex((pendingTimeouts) =>
      timeoutValuesMatch(pendingTimeouts, incomingTimeouts)
    )
    if (pendingIndex >= 0) {
      pendingTimeoutsRef.current.splice(0, pendingIndex + 1)
      if (pendingTimeoutsRef.current.length === 0) {
        latestTimeoutsRef.current = incomingTimeouts
      }
      return
    }
    pendingTimeoutsRef.current = []
    latestTimeoutsRef.current = incomingTimeouts
  }, [settings.worktreeCreateTimeouts])

  if (!matchesSearch) {
    return null
  }

  const expanded = open || forcedOpen
  const updateTimeout = (field: keyof WorktreeCreateTimeouts, seconds: number): void => {
    const nextTimeouts = {
      ...latestTimeoutsRef.current,
      [field]: Math.round(seconds * 1000)
    }
    latestTimeoutsRef.current = nextTimeouts
    pendingTimeoutsRef.current.push(nextTimeouts)
    void updateSettings({ worktreeCreateTimeouts: nextTimeouts })
  }

  return (
    <SearchableSetting {...searchEntry} forceVisible>
      <Collapsible
        open={expanded}
        onOpenChange={(nextOpen) => {
          if (!forcedOpen) {
            setOpen(nextOpen)
          }
        }}
        className="border-t border-border/50 pt-2"
      >
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={forcedOpen}
            className="-ml-2 h-8 px-2 text-sm font-semibold disabled:cursor-default disabled:opacity-100"
          >
            <ChevronRight
              className={cn(
                'size-3.5 text-muted-foreground transition-transform',
                expanded && 'rotate-90'
              )}
            />
            {searchEntry.title}
            <SettingsBadge tone="muted">
              {translate(
                'auto.components.settings.WorktreeCreateTimeoutSettings.advanced',
                'Advanced'
              )}
            </SettingsBadge>
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-2 rounded-md border border-border/60 bg-muted/20 px-3 py-3">
            <p className="pb-1 text-xs text-muted-foreground">{searchEntry.description}</p>
            <div className="divide-y divide-border/50">
              {getTimeoutFields().map((field) => (
                <NumberField
                  key={field.key}
                  label={field.label}
                  description={field.description}
                  value={configuredTimeouts[field.key] / 1000}
                  min={MIN_TIMEOUT_SECONDS}
                  max={MAX_TIMEOUT_SECONDS}
                  step={1}
                  suffix={translate(
                    'auto.components.settings.WorktreeCreateTimeoutSettings.seconds',
                    'seconds'
                  )}
                  onChange={(seconds) => updateTimeout(field.key, seconds)}
                />
              ))}
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </SearchableSetting>
  )
}
