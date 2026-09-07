import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type {
  GitHubProjectOwnerType,
  GitHubProjectSettings,
  GitHubProjectViewSummary
} from '../../../../shared/github/project-types'
import {
  GITHUB_PROJECT_REF_INPUT_TOO_LARGE_ERROR,
  hasBoundedGitHubProjectRefInputText,
  isGitHubProjectRefInputTooLarge
} from '../../../../shared/github/project-ref-input'
import {
  githubProjectHost,
  githubProjectIdentityKey
} from '../../../../shared/github/project-identity'
import { filterGitHubProjectPickerProjects } from './github-project-picker-filter'
import { ProjectPickerBrowse } from './ProjectPickerBrowse'
import { ProjectViewPickStep } from './ProjectPickerPanels'
import { parseProjectInput } from './project-picker-input'
import {
  getProjectPickerBrowseHost,
  listProjectViewsForRuntime,
  resolveProjectRefForRuntime
} from './project-picker-runtime'
import type { ProjectPickerChoice, ResolvedProjectSelection } from './project-picker-selection'
import { useProjectPickerBrowse } from './useProjectPickerBrowse'

export type { ResolvedProjectSelection } from './project-picker-selection'
export { getProjectPickerBrowseHost } from './project-picker-runtime'
export { parseProjectInput } from './project-picker-input'

type Props = {
  activeProject: {
    owner: string
    ownerType: GitHubProjectOwnerType
    number: number
    host?: string
    title?: string
  } | null
  onSelect: (selection: ResolvedProjectSelection) => void
}

const EMPTY_PROJECT_SETTINGS: GitHubProjectSettings = {
  pinned: [],
  recent: [],
  lastViewByProject: {},
  activeProject: null
}

export default function ProjectPicker({ activeProject, onSelect }: Props): React.JSX.Element {
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const mountedRef = useMountedRef()
  const projectSettings = useMemo(
    () => settings?.githubProjects ?? EMPTY_PROJECT_SETTINGS,
    [settings?.githubProjects]
  )
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [pasteInput, setPasteInput] = useState('')
  const [pasteError, setPasteError] = useState<string | null>(null)
  const [pasteBusy, setPasteBusy] = useState(false)
  const [viewPickFor, setViewPickFor] = useState<ResolvedProjectSelection | null>(null)
  const [viewList, setViewList] = useState<GitHubProjectViewSummary[]>([])
  const [viewLoading, setViewLoading] = useState(false)
  const browseHost = getProjectPickerBrowseHost(activeProject ?? projectSettings.activeProject)
  const browse = useProjectPickerBrowse(settings, browseHost)
  const { loadBrowse } = browse

  useEffect(() => {
    if (open && !viewPickFor) {
      void loadBrowse()
    }
  }, [loadBrowse, open, viewPickFor])

  const updateProjectSettings = useCallback(
    async (mutate: (previous: GitHubProjectSettings) => GitHubProjectSettings) => {
      await updateSettings({ githubProjects: mutate(projectSettings) })
    },
    [projectSettings, updateSettings]
  )

  const commitSelection = useCallback(
    async (selection: ResolvedProjectSelection) => {
      const key = githubProjectIdentityKey({
        owner: selection.owner,
        ownerType: selection.ownerType,
        number: selection.projectNumber,
        host: selection.host
      })
      await updateProjectSettings((previous) => {
        const recent = [
          {
            owner: selection.owner,
            ownerType: selection.ownerType,
            number: selection.projectNumber,
            host: githubProjectHost(selection.host),
            lastOpenedAt: new Date().toISOString()
          },
          ...previous.recent.filter((entry) => githubProjectIdentityKey(entry) !== key)
        ].slice(0, 10)
        return {
          ...previous,
          recent,
          lastViewByProject: selection.viewId
            ? { ...previous.lastViewByProject, [key]: { viewId: selection.viewId } }
            : previous.lastViewByProject,
          activeProject: {
            owner: selection.owner,
            ownerType: selection.ownerType,
            number: selection.projectNumber,
            host: githubProjectHost(selection.host)
          }
        }
      })
      if (!mountedRef.current) {
        return
      }
      onSelect(selection)
      setOpen(false)
      setQuery('')
      setViewPickFor(null)
    },
    [mountedRef, onSelect, updateProjectSettings]
  )

  const handleChooseProject = useCallback(
    async (choice: ProjectPickerChoice) => {
      const key = githubProjectIdentityKey(choice)
      const lastView = projectSettings.lastViewByProject[key]?.viewId
      if (lastView && choice.viewNumber === undefined) {
        await commitSelection(toSelection(choice, lastView))
        return
      }
      const selection = toSelection(choice)
      setViewPickFor(selection)
      setViewLoading(true)
      try {
        const result = await listProjectViewsForRuntime(settings, {
          owner: choice.owner,
          ownerType: choice.ownerType,
          projectNumber: choice.number,
          host: githubProjectHost(choice.host)
        })
        if (!mountedRef.current) {
          return
        }
        if (!result.ok) {
          setViewList([])
          toast.error(result.error.message)
          return
        }
        setViewList(result.views)
        const requestedView = result.views.find((view) => view.number === choice.viewNumber)
        if (requestedView) {
          await commitSelection({ ...selection, viewId: requestedView.id })
        }
      } catch (error) {
        if (mountedRef.current) {
          setViewList([])
          toast.error(
            translate(
              'auto.components.github.project.ProjectPicker.44b2c6326b',
              'Failed to load views: {{value0}}',
              { value0: error instanceof Error ? error.message : String(error) }
            )
          )
        }
      } finally {
        if (mountedRef.current) {
          setViewLoading(false)
        }
      }
    },
    [commitSelection, mountedRef, projectSettings.lastViewByProject, settings]
  )

  const handlePaste = useCallback(async () => {
    if (isGitHubProjectRefInputTooLarge(pasteInput)) {
      setPasteError(GITHUB_PROJECT_REF_INPUT_TOO_LARGE_ERROR)
      return
    }
    const input = pasteInput.trim()
    const parsed = parseProjectInput(input)
    if (!parsed) {
      setPasteError('Expected a project URL or owner/number')
      return
    }
    setPasteError(null)
    setPasteBusy(true)
    try {
      const result = await resolveProjectRefForRuntime(settings, input, parsed.host)
      if (!mountedRef.current) {
        return
      }
      if (!result.ok) {
        setPasteError(result.error.message)
        return
      }
      setPasteInput('')
      await handleChooseProject({
        owner: result.owner,
        ownerType: result.ownerType,
        number: result.number,
        host: githubProjectHost(result.host ?? parsed.host),
        title: result.title,
        ...(result.viewNumber !== undefined ? { viewNumber: result.viewNumber } : {})
      })
    } finally {
      if (mountedRef.current) {
        setPasteBusy(false)
      }
    }
  }, [handleChooseProject, mountedRef, pasteInput, settings])

  const filteredBrowse = useMemo(
    () =>
      filterGitHubProjectPickerProjects({
        projects: browse.browseProjects,
        pinned: projectSettings.pinned,
        recent: projectSettings.recent,
        query
      }),
    [browse.browseProjects, projectSettings.pinned, projectSettings.recent, query]
  )
  const buttonLabel = activeProject
    ? `${activeProject.owner} / ${activeProject.title ?? `#${activeProject.number}`}`
    : 'Choose a project'

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1 border-border/50 bg-transparent text-xs"
        >
          <span className="truncate">{buttonLabel}</span>
          <ChevronDown className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[360px] p-0" align="start">
        {viewPickFor ? (
          <ProjectViewPickStep
            loading={viewLoading}
            views={viewList}
            onPick={(view) => commitSelection({ ...viewPickFor, viewId: view.id })}
            onBack={() => setViewPickFor(null)}
          />
        ) : (
          <ProjectPickerBrowse
            {...browse}
            browseHost={browseHost}
            filteredBrowse={filteredBrowse}
            projectSettings={projectSettings}
            query={query}
            onQueryChange={setQuery}
            onChooseProject={handleChooseProject}
            onUpdateSettings={updateProjectSettings}
            pasteInput={pasteInput}
            pasteError={pasteError}
            pasteBusy={pasteBusy}
            canSubmitPasteInput={!pasteBusy && hasBoundedGitHubProjectRefInputText(pasteInput)}
            onPasteInputChange={(input, error) => {
              setPasteInput(input)
              setPasteError(error)
            }}
            onPaste={handlePaste}
          />
        )}
      </PopoverContent>
    </Popover>
  )
}

function toSelection(choice: ProjectPickerChoice, viewId?: string): ResolvedProjectSelection {
  return {
    owner: choice.owner,
    ownerType: choice.ownerType,
    projectNumber: choice.number,
    host: githubProjectHost(choice.host),
    ...(viewId ? { viewId } : {})
  }
}
