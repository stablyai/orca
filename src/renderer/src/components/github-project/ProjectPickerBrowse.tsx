import React from 'react'
import { Loader, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import type {
  GitHubProjectSettings,
  GitHubProjectSummary
} from '../../../../shared/github/project-types'
import type { GitHubProjectViewError } from '../../../../shared/github/project-result-types'
import {
  GITHUB_PROJECT_REF_INPUT_TOO_LARGE_ERROR,
  isGitHubProjectRefInputTooLarge
} from '../../../../shared/github/project-ref-input'
import {
  githubProjectHost,
  githubProjectIdentityKey
} from '../../../../shared/github/project-identity'
import type { ProjectPickerChoice } from './project-picker-selection'
import {
  ProjectPickerError,
  ProjectPickerPartialFailures,
  ProjectPickerRow,
  ProjectPickerSection
} from './ProjectPickerPanels'

type Props = {
  query: string
  onQueryChange: (query: string) => void
  browseHost: string
  browseError: GitHubProjectViewError | null
  browseLoading: boolean
  browseProjects: GitHubProjectSummary[]
  filteredBrowse: GitHubProjectSummary[]
  partialFailures: { owner: string; message: string }[]
  projectSettings: GitHubProjectSettings
  onChooseProject: (choice: ProjectPickerChoice) => void | Promise<void>
  onUpdateSettings: (
    mutate: (previous: GitHubProjectSettings) => GitHubProjectSettings
  ) => void | Promise<void>
  pasteInput: string
  pasteError: string | null
  pasteBusy: boolean
  canSubmitPasteInput: boolean
  onPasteInputChange: (input: string, error: string | null) => void
  onPaste: () => void | Promise<void>
}

export function ProjectPickerBrowse(props: Props): React.JSX.Element {
  return (
    <div className="flex flex-col">
      <div className="border-b border-border/50 p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={props.query}
            onChange={(event) => props.onQueryChange(event.target.value)}
            placeholder={translate(
              'auto.components.github.project.ProjectPicker.f492e1b539',
              'Search projects'
            )}
            className="h-8 pl-7 text-xs"
          />
        </div>
      </div>
      {props.browseError ? (
        <ProjectPickerError error={props.browseError} host={props.browseHost} />
      ) : null}
      {!props.browseError && props.partialFailures.length > 0 ? (
        <ProjectPickerPartialFailures failures={props.partialFailures} />
      ) : null}
      <ProjectBrowseRows {...props} />
      <ProjectPasteInput {...props} />
    </div>
  )
}

function ProjectBrowseRows(props: Props): React.JSX.Element {
  const { projectSettings } = props
  return (
    <div className="max-h-[340px] overflow-y-auto p-1 scrollbar-sleek">
      {projectSettings.pinned.length > 0 ? (
        <ProjectPickerSection
          label={translate('auto.components.github.project.ProjectPicker.707843206c', 'Pinned')}
        >
          {projectSettings.pinned.map((project) => {
            const key = githubProjectIdentityKey(project)
            const match = props.browseProjects.find(
              (candidate) => githubProjectIdentityKey(candidate) === key
            )
            return (
              <ProjectPickerRow
                key={key}
                title={match?.title ?? `#${project.number}`}
                subtitle={project.owner}
                zombie={projectSettings.lastViewByProject[key]?.viewId == null}
                onClick={() =>
                  props.onChooseProject({
                    owner: project.owner,
                    ownerType: project.ownerType,
                    number: project.number,
                    host: githubProjectHost(project.host),
                    title: match?.title
                  })
                }
                onRemovePin={() =>
                  props.onUpdateSettings((previous) => ({
                    ...previous,
                    pinned: previous.pinned.filter(
                      (candidate) => githubProjectIdentityKey(candidate) !== key
                    )
                  }))
                }
              />
            )
          })}
        </ProjectPickerSection>
      ) : null}
      {projectSettings.recent.length > 0 ? <RecentProjects {...props} /> : null}
      <ProjectPickerSection
        label={translate(
          props.browseLoading
            ? 'auto.components.github.project.ProjectPicker.ba0ab9a117'
            : 'auto.components.github.project.ProjectPicker.b787682111',
          props.browseLoading ? 'Browse all (loading…)' : 'Browse all'
        )}
      >
        {props.browseLoading ? (
          <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
            <Loader className="size-3 animate-spin" />
            {translate('auto.components.github.project.ProjectPicker.7b6d39627e', 'Loading…')}
          </div>
        ) : null}
        {props.filteredBrowse.map((project) => (
          <ProjectPickerRow
            key={githubProjectIdentityKey(project)}
            title={project.title}
            subtitle={project.owner}
            onClick={() =>
              props.onChooseProject({
                owner: project.owner,
                ownerType: project.ownerType,
                number: project.number,
                host: githubProjectHost(project.host),
                title: project.title
              })
            }
          />
        ))}
      </ProjectPickerSection>
    </div>
  )
}

function RecentProjects(props: Props): React.JSX.Element {
  const { projectSettings } = props
  const projects = projectSettings.recent.filter(
    (recent) =>
      !projectSettings.pinned.some(
        (pinned) => githubProjectIdentityKey(pinned) === githubProjectIdentityKey(recent)
      )
  )
  return (
    <ProjectPickerSection
      label={translate('auto.components.github.project.ProjectPicker.b3044b7a25', 'Recent')}
    >
      {projects.map((project) => {
        const key = githubProjectIdentityKey(project)
        const match = props.browseProjects.find(
          (candidate) => githubProjectIdentityKey(candidate) === key
        )
        return (
          <ProjectPickerRow
            key={key}
            title={match?.title ?? `#${project.number}`}
            subtitle={project.owner}
            canPin={projectSettings.lastViewByProject[key]?.viewId != null}
            onPin={() =>
              props.onUpdateSettings((previous) => ({
                ...previous,
                pinned: [
                  ...previous.pinned,
                  {
                    owner: project.owner,
                    ownerType: project.ownerType,
                    number: project.number,
                    host: githubProjectHost(project.host)
                  }
                ].slice(0, 20)
              }))
            }
            onClick={() =>
              props.onChooseProject({
                owner: project.owner,
                ownerType: project.ownerType,
                number: project.number,
                host: githubProjectHost(project.host),
                title: match?.title
              })
            }
          />
        )
      })}
    </ProjectPickerSection>
  )
}

function ProjectPasteInput(props: Props): React.JSX.Element {
  return (
    <div className="border-t border-border/50 p-2">
      <div className="flex gap-2">
        <Input
          value={props.pasteInput}
          onChange={(event) => {
            const input = event.target.value
            props.onPasteInputChange(
              input,
              isGitHubProjectRefInputTooLarge(input)
                ? GITHUB_PROJECT_REF_INPUT_TOO_LARGE_ERROR
                : null
            )
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              void props.onPaste()
            }
          }}
          placeholder={translate(
            'auto.components.github.project.ProjectPicker.5113ecc298',
            'Add by URL or owner/number'
          )}
          className="h-8 text-xs"
        />
        <Button
          size="sm"
          onClick={() => void props.onPaste()}
          disabled={!props.canSubmitPasteInput}
          className="h-8"
        >
          {translate('auto.components.github.project.ProjectPicker.fce99a24a7', 'Add')}
        </Button>
      </div>
      {props.pasteError ? (
        <div className="mt-1 text-[11px] text-destructive">{props.pasteError}</div>
      ) : null}
    </div>
  )
}
