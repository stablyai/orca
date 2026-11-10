import { useMemo } from 'react'
import { Server } from 'lucide-react'
import type { SettingsNavSection } from '@/lib/settings-navigation-types'
import { basename } from '@/lib/path'
import { cn } from '@/lib/utils'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { getExecutionHostLabel } from '../../../../../shared/execution-host'
import { buildExecutionHostRegistry } from '../../../../../shared/execution-host/execution-host-registry'
import { getHostDisplayLabelOverrides } from '../../../../../shared/host-setting-overrides'
import { HostRowIcon } from '../../host-row-icon'
import { RepoIconGlyph } from '../../repo/repo-icon'
import { RepoForkIndicator } from '../../repo/repo-fork-indicator'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'

export type RepoNavSection = Omit<SettingsNavSection, 'description' | 'searchEntries' | 'group'>

function checkoutDisplayPath(path: string): string {
  // Recognized per-user roots belong to the checkout's host, not the renderer's host.
  return path
    .replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/u, '~')
    .replace(/^[a-z]:[\\/]Users[\\/][^\\/]+(?=[\\/]|$)/iu, '~')
}

export function SettingsProjectTree({
  sections,
  activeSectionId,
  onSelectSection,
  rowClassName
}: {
  sections: RepoNavSection[]
  activeSectionId: string
  onSelectSection: (id: string) => void
  rowClassName: (active: boolean) => string
}): React.JSX.Element {
  const t = useTranslate()
  const repos = useAppStore((state) => state.repos)
  const settings = useAppStore((state) => state.settings)
  const sshTargetLabels = useAppStore((state) => state.sshTargetLabels)
  const runtimeEnvironments = useAppStore((state) => state.runtimeEnvironments)
  const hostLabels = useMemo(
    () =>
      new Map(
        buildExecutionHostRegistry({
          repos,
          settings,
          sshTargetLabels,
          runtimeEnvironments,
          hostLabelOverrides: getHostDisplayLabelOverrides(settings)
        }).flatMap((host) =>
          [host.id, ...(host.aliasHostIds ?? [])].map((id) => [id, host.label] as const)
        )
      ),
    [repos, settings, sshTargetLabels, runtimeEnvironments]
  )
  const groups = useMemo(() => {
    const byProject = new Map<string, RepoNavSection[]>()
    for (const section of sections) {
      const key = section.projectCopy?.split ? section.projectCopy.projectId : section.id
      const siblings = byProject.get(key)
      if (siblings) {
        siblings.push(section)
      } else {
        byProject.set(key, [section])
      }
    }
    return [...byProject.values()]
  }, [sections])

  const renderRow = (section: RepoNavSection, child: boolean): React.JSX.Element => {
    const copy = child ? section.projectCopy : undefined
    const active = activeSectionId === section.id
    const name = copy ? basename(copy.path) || copy.projectTitle : section.title
    const hostLabel = copy
      ? (hostLabels.get(copy.hostId) ?? getExecutionHostLabel(copy.hostId))
      : ''
    return (
      <button
        key={section.id}
        type="button"
        aria-current={active ? 'page' : undefined}
        data-current={active ? 'true' : undefined}
        onClick={() => onSelectSection(section.id)}
        className={cn(rowClassName(active), copy && 'block')}
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">
          {copy ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={0} role="img" aria-label={hostLabel} className="shrink-0">
                  <HostRowIcon hostId={copy.hostId} className="size-4 text-muted-foreground" />
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {hostLabel}
              </TooltipContent>
            </Tooltip>
          ) : (
            <RepoIconGlyph
              repoIcon={section.repoIcon}
              color={section.badgeColor}
              className="size-4 shrink-0 text-muted-foreground"
              iconClassName="size-3.5"
            />
          )}
          <span className="truncate" title={name}>
            {name}
          </span>
          <RepoForkIndicator upstream={section.upstream} />
          {!child && section.isRemote ? (
            <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-3xs text-muted-foreground">
              <Server className="size-3" />
              {t('auto.components.settings.SettingsSidebar.e0900f83e7', 'SSH')}
            </span>
          ) : null}
        </span>
        {copy ? (
          <span
            className="mt-0.5 block truncate pl-6 font-mono text-xs font-normal text-muted-foreground"
            title={copy.path}
          >
            {checkoutDisplayPath(copy.path)}
          </span>
        ) : null}
      </button>
    )
  }

  return (
    <>
      {groups.map((children) => {
        const first = children[0]
        if (!first.projectCopy?.split) {
          return renderRow(first, false)
        }
        const targetId = first.projectCopy.sectionIds.includes(activeSectionId)
          ? activeSectionId
          : first.id
        return (
          <div key={first.projectCopy.projectId}>
            <button
              type="button"
              onClick={() => onSelectSection(targetId)}
              className={rowClassName(false)}
            >
              <RepoIconGlyph
                repoIcon={first.repoIcon}
                color={first.badgeColor}
                className="size-4 shrink-0 text-muted-foreground"
                iconClassName="size-3.5"
              />
              <span className="truncate">{first.projectCopy.projectTitle}</span>
            </button>
            <div className="ml-3 space-y-1 border-l border-worktree-sidebar-border pl-2">
              {children.map((child) => renderRow(child, true))}
            </div>
          </div>
        )
      })}
    </>
  )
}
