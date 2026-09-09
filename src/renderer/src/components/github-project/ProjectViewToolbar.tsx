import React, { useEffect, useRef, useState } from 'react'
import { ExternalLink, RefreshCw, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import ProjectPicker from './ProjectPicker'
import type { ProjectViewTableState } from './useProjectViewTable'
import { githubProjectHost } from '../../../../shared/github/project-identity'

export function ProjectViewToolbar({ tableState }: { tableState: ProjectViewTableState }) {
  const {
    activeProject,
    table,
    visibleTable,
    currentProjectViewKey,
    appliedQueryByView,
    currentAppliedOverride,
    loading,
    viewId,
    doFetch,
    setAppliedQueryByView
  } = tableState
  const selectedViewUrl = table
    ? `${table.project.url}/views/${table.selectedView.number ?? ''}`
    : null
  const refreshLabel = loading
    ? translate('auto.components.github.project.ProjectViewWrapper.a8fa0d2bf5', 'Refreshing')
    : translate('auto.components.github.project.ProjectViewWrapper.71fb69926c', 'Refresh')
  const refresh = (): void => {
    if (!activeProject || !viewId) {
      return
    }
    void doFetch(
      {
        owner: activeProject.owner,
        ownerType: activeProject.ownerType,
        projectNumber: activeProject.number,
        host: githubProjectHost(activeProject.host),
        viewId
      },
      true,
      currentAppliedOverride
    )
  }
  return (
    <div className="flex min-w-0 flex-none flex-wrap items-center gap-2 border-b border-border/50 bg-muted/30 px-3 py-2">
      <ProjectPicker
        activeProject={
          activeProject
            ? {
                owner: activeProject.owner,
                ownerType: activeProject.ownerType,
                number: activeProject.number,
                host: githubProjectHost(activeProject.host),
                ...(table ? { title: table.project.title } : {})
              }
            : null
        }
        onSelect={(selection) => void doFetch(selection, true)}
      />
      {currentProjectViewKey ? (
        <ProjectSearchInput
          key={currentProjectViewKey}
          viewFilter={table?.selectedView.filter ?? ''}
          appliedOverride={appliedQueryByView[currentProjectViewKey]}
          onApply={(override) => {
            if (!activeProject || !viewId) {
              return
            }
            setAppliedQueryByView((previous) => {
              const next = { ...previous }
              if (override === undefined) {
                delete next[currentProjectViewKey]
              } else {
                next[currentProjectViewKey] = override
              }
              return next
            })
            void doFetch(
              {
                owner: activeProject.owner,
                ownerType: activeProject.ownerType,
                projectNumber: activeProject.number,
                host: githubProjectHost(activeProject.host),
                viewId
              },
              true,
              override
            )
          }}
        />
      ) : null}
      {table ? (
        <>
          <span className="ml-auto rounded-full border border-border/50 bg-background px-2 py-0.5 text-[11px]">
            {visibleTable?.totalCount ?? table.totalCount}
          </span>
          {selectedViewUrl ? (
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7"
              onClick={() => void window.api.shell.openUrl(selectedViewUrl)}
              aria-label={translate(
                'auto.components.github.project.ProjectViewWrapper.fd15491034',
                'Open view in GitHub'
              )}
            >
              <ExternalLink className="size-3.5" />
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="icon"
            className="h-7 w-7 cursor-pointer disabled:pointer-events-auto disabled:cursor-wait"
            onClick={refresh}
            disabled={loading}
            aria-busy={loading}
            aria-label={refreshLabel}
            title={refreshLabel}
          >
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
          </Button>
        </>
      ) : null}
    </div>
  )
}

function ProjectSearchInput({
  viewFilter,
  appliedOverride,
  onApply
}: {
  viewFilter: string
  appliedOverride: string | undefined
  onApply: (nextOverride: string | undefined) => void
}): React.JSX.Element {
  const applied = appliedOverride !== undefined ? appliedOverride : viewFilter
  const [value, setValue] = useState(applied)
  const inputRef = useRef<HTMLInputElement>(null)
  const dirty = value !== applied
  const apply = (next: string): void => onApply(next === viewFilter ? undefined : next)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const modifierPressed = navigator.userAgent.includes('Mac') ? event.metaKey : event.ctrlKey
      if (!modifierPressed || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'f') {
        return
      }
      if (document.querySelector('[role="dialog"]')) {
        return
      }
      const input = inputRef.current
      if (!input) {
        return
      }
      const target = event.target
      if (
        target instanceof HTMLElement &&
        target !== input &&
        (target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target.isContentEditable)
      ) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      input.focus()
      input.select()
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [])

  return (
    <div className="relative min-w-0 max-w-xl flex-1 basis-64">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={inputRef}
        data-github-project-search-input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault()
            apply(value)
          } else if (event.key === 'Escape') {
            setValue(applied)
            event.currentTarget.blur()
          }
        }}
        onBlur={() => {
          if (dirty) {
            apply(value)
          }
        }}
        placeholder={
          viewFilter ||
          translate(
            'auto.components.github.project.ProjectViewWrapper.067119985c',
            'GitHub search, e.g. assignee:@me is:open'
          )
        }
        title={
          viewFilter
            ? translate(
                'auto.components.github.project.ProjectViewWrapper.c5bc7ec007',
                'View filter: {{value0}}',
                { value0: viewFilter }
              )
            : undefined
        }
        className={cn(
          'h-7 rounded-md border-border/50 bg-background pl-8 pr-7 text-[11px]',
          dirty && 'border-amber-500/50'
        )}
      />
      {value ? (
        <button
          type="button"
          aria-label={translate(
            'auto.components.github.project.ProjectViewWrapper.7245c3d7ac',
            'Clear search'
          )}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setValue('')
            apply('')
          }}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground transition hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      ) : null}
    </div>
  )
}
