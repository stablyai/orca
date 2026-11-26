import React, { useMemo, useState } from 'react'
import { Folder, Info, LoaderCircle, Plus, Server, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { BotConnectorRowFrame } from '@/components/bots/BotConnectorRow'
import { searchRepos } from '@/lib/workspace/catalog/repo-search'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { namesLine } from '@/components/bots/bot-settings-row-states'
import { botAgentLabel } from '@/components/bots/bot-presentation'
import {
  getRepoExecutionHostId,
  parseExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import { BOT_MAX_SKILL_PROJECTS, type Bot } from '../../../../../shared/bot-types'
import {
  BOT_AGENTS_LISTING_LINKED_SKILLS,
  type BotOwnSkillsView,
  type BotSkillProjectView
} from '../../../../../shared/bots/bot-skill-projects'
import type { BotAgentSkillsFolder } from '../../../../../shared/bots/bot-package'
import type { Repo } from '../../../../../shared/repository/repo-types'
import { SettingsSubsectionHeader } from '../form-controls/SettingsFormControls'
import { botSkillSourceNames, useBotOwnSkills, useBotSkillProjects } from './use-bot-skill-projects'
import { FolderLine, PlainRow, SkillList, skillCount, type ListedSkill } from './BotSkillRowParts'

function RemoveButton({ onRemove }: { onRemove: () => void }): React.JSX.Element {
  const t = useTranslate()
  const label = t('settings.bots.skills.remove', 'Remove')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label={label} onClick={onRemove}>
          <Trash2 />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  )
}

/** The SSH host a project is on, by the name the owner gave it; null for any other host. */
function useSshHostLabel(repo: Repo | undefined): string | null {
  const labels = useAppStore((state) => state.sshTargetLabels)
  const parsed = repo ? parseExecutionHostId(getRepoExecutionHostId(repo)) : null
  return parsed?.kind === 'ssh' ? (labels.get(parsed.targetId) ?? parsed.targetId) : null
}

function remoteDescription(bot: Bot, host: string | null): string {
  return host
    ? translate(
        'settings.bots.skills.remoteSsh',
        'On {{host}} over SSH. {{bot}} runs on this computer, so it can’t load these yet.',
        { host, bot: bot.name }
      )
    : translate(
        'settings.bots.skills.remote',
        'On another host. {{bot}} runs on this computer, so it can’t load these yet.',
        { bot: bot.name }
      )
}

function ProjectRow(props: {
  bot: Bot
  repo: Repo | undefined
  name: string
  view: BotSkillProjectView | undefined
  onRemove: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const { bot, name, view, onRemove } = props
  const host = useSshHostLabel(props.repo)
  const folderIcon = <Folder className="size-4 text-muted-foreground" />
  if (!view) {
    return (
      <PlainRow
        icon={folderIcon}
        name={name}
        description={t('settings.bots.skills.reading', 'Reading its skills…')}
        trailing={<LoaderCircle className="size-4 animate-spin text-muted-foreground" />}
      />
    )
  }
  if (view.status !== 'local') {
    return (
      <PlainRow
        icon={<Server className="size-4 text-muted-foreground" />}
        name={view.name}
        description={
          view.status === 'remote'
            ? remoteDescription(bot, host)
            : t('settings.bots.skills.missing', 'This project is no longer in Orca.')
        }
        trailing={
          <>
            {view.status === 'remote' ? (
              <span className="text-xs whitespace-nowrap text-muted-foreground">
                {t('settings.bots.skills.notYet', 'Not available yet')}
              </span>
            ) : null}
            <RemoveButton onRemove={onRemove} />
          </>
        }
      />
    )
  }
  const { skillsDir, skills } = view
  if (!skillsDir || skills.length === 0) {
    return (
      <PlainRow
        icon={folderIcon}
        name={view.name}
        description={t(
          'settings.bots.skills.none',
          'No skills in this project yet. Run your project’s setup to add its skills; they load in {{bot}}’s next chat.',
          { bot: bot.name }
        )}
        trailing={
          <>
            <span className="text-xs whitespace-nowrap text-muted-foreground">{skillCount(0)}</span>
            <RemoveButton onRemove={onRemove} />
          </>
        }
      />
    )
  }
  return (
    <BotConnectorRowFrame
      icon={folderIcon}
      name={view.name}
      description={skillCount(skills.length)}
      status={null}
      trailing={null}
    >
      <SkillList skills={skills.map((skill) => ({ ...skill, id: skill.name }))} />
      <FolderLine folder={skillsDir} hostId={bot.hostId}>
        <RemoveButton onRemove={onRemove} />
      </FolderLine>
    </BotConnectorRowFrame>
  )
}

/** Which agents load a skill, from the agent folders that reach it; no label when both do. */
function loadedByLabel(
  loadedBy: readonly BotAgentSkillsFolder[] | undefined,
  t: ReturnType<typeof useTranslate>
): string | undefined {
  // Unknown (a host that doesn't say), or both: no label.
  if (!loadedBy || (loadedBy.includes('claude') && loadedBy.includes('agents'))) {
    return undefined
  }
  if (loadedBy.length === 0) {
    return t('settings.bots.skills.notLoaded', 'No agent loads it')
  }
  return loadedBy.includes('claude')
    ? t('settings.bots.skills.claudeOnly', 'Claude only')
    : t('settings.bots.skills.notClaude', 'Not for Claude')
}

/** The bot's own skills: skills/ in its home, which every agent loads, then any only one agent's folder holds. */
function OwnSkillsRow({
  bot,
  own
}: {
  bot: Bot
  own: BotOwnSkillsView | undefined
}): React.JSX.Element {
  const t = useTranslate()
  const name = t('settings.bots.skills.own', '{{bot}}’s own skills', { bot: bot.name })
  const folderIcon = <Folder className="size-4 text-muted-foreground" />
  if (!own) {
    return (
      <PlainRow
        icon={folderIcon}
        name={name}
        description={t('settings.bots.skills.reading', 'Reading its skills…')}
        trailing={<LoaderCircle className="size-4 animate-spin text-muted-foreground" />}
      />
    )
  }
  const skills: ListedSkill[] = [
    ...own.skills.map((skill) => ({
      ...skill,
      id: skill.folder,
      label: loadedByLabel(skill.loadedBy, t)
    })),
    ...own.agentOnly.map((skill) => ({
      ...skill,
      id: skill.folder,
      label: loadedByLabel(skill.loadedBy, t)
    }))
  ]
  if (skills.length === 0) {
    return (
      <PlainRow
        icon={folderIcon}
        name={name}
        description={t('settings.bots.skills.ownNone', 'No skills of its own yet.')}
        trailing={
          <span className="text-xs whitespace-nowrap text-muted-foreground">{skillCount(0)}</span>
        }
      />
    )
  }
  return (
    <BotConnectorRowFrame
      icon={folderIcon}
      name={name}
      description={skillCount(skills.length)}
      status={null}
      trailing={null}
    >
      <SkillList skills={skills} />
      <FolderLine folder={own.skillsDir} hostId={bot.hostId} />
    </BotConnectorRowFrame>
  )
}

function pickerDetail(view: BotSkillProjectView | undefined): string {
  if (!view) {
    return ''
  }
  if (view.status === 'remote') {
    return translate('settings.bots.skills.notYet', 'Not available yet')
  }
  return view.skills.length > 0
    ? skillCount(view.skills.length)
    : translate('settings.bots.skills.noneShort', 'No skills')
}

function LinkProjectRow(props: {
  bot: Bot
  repos: readonly Repo[]
  linked: readonly string[]
  onChange: (next: string[]) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const views = useBotSkillProjects(
    props.bot,
    props.repos.map((repo) => repo.id),
    open
  )
  const shown = useMemo(() => searchRepos(props.repos, query), [props.repos, query])
  const toggle = (repoId: string): void => {
    props.onChange(
      props.linked.includes(repoId)
        ? props.linked.filter((id) => id !== repoId)
        : [...props.linked, repoId].slice(0, BOT_MAX_SKILL_PROJECTS)
    )
  }
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        setQuery('')
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors outline-none hover:bg-accent/40 focus-visible:bg-accent/40"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-dashed border-muted-foreground/50 text-muted-foreground">
            <Plus className="size-4" />
          </span>
          <span className="text-sm font-medium">
            {t('settings.bots.skills.link', 'Link a project')}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(360px,calc(100vw-1rem))]">
        <Command shouldFilter={false}>
          <CommandInput
            autoFocus
            placeholder={t('settings.bots.skills.search', 'Search projects')}
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            <CommandEmpty>
              {t('settings.bots.skills.noMatch', 'No projects match your search.')}
            </CommandEmpty>
            {shown.map((repo) => {
              const view = views?.get(repo.id)
              const remote = view?.status === 'remote'
              const linked = props.linked.includes(repo.id)
              return (
                <CommandItem
                  key={repo.id}
                  value={repo.id}
                  // A linked project on another host can still be unlinked.
                  disabled={remote && !linked}
                  onSelect={() => toggle(repo.id)}
                >
                  <span className="flex w-full min-w-0 items-center gap-2">
                    <Checkbox checked={linked} tabIndex={-1} aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{repo.displayName}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {views ? pickerDetail(view) : null}
                    </span>
                  </span>
                </CommandItem>
              )
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** Settings › Bots › this bot › Skills: its own skills, then projects whose skills it loads when a chat starts. */
export function BotSkillsSection({
  bot,
  onChange
}: {
  bot: Bot
  onChange: (skillProjects: string[]) => void
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const repos = useAppStore((state) => state.repos)
  const linked = bot.skillProjects ?? []
  const views = useBotSkillProjects(bot, linked)
  const own = useBotOwnSkills(bot)
  const agent = botAgentLabel(bot.agent)
  const listsSkills =
    BOT_AGENTS_LISTING_LINKED_SKILLS.includes(bot.agent) &&
    linked.some((id) => (views?.get(id)?.skills.length ?? 0) > 0)
  return (
    <section className="space-y-3">
      <SettingsSubsectionHeader
        title={t('settings.bots.skills.title', 'Skills')}
        description={namesLine(
          botSkillSourceNames(
            own,
            linked.flatMap((id) => repos.find((repo) => repo.id === id)?.displayName ?? [])
          ),
          intlLocale
        )}
      />
      <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card shadow-xs">
        {listsSkills ? (
          <p className="flex gap-2 px-4 py-3 text-xs text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>
              <span className="font-medium text-foreground">
                {t(
                  'settings.bots.skills.listedTitle',
                  '{{agent}} can’t load these skills directly.',
                  { agent }
                )}
              </span>{' '}
              {t(
                'settings.bots.skills.listedBody',
                '{{bot}} gets a list of them in its instructions and reads one when it fits. They won’t appear in its / menu.',
                { bot: bot.name }
              )}
            </span>
          </p>
        ) : null}
        {own === null ? null : <OwnSkillsRow bot={bot} own={own} />}
        {linked.map((repoId) => (
          <ProjectRow
            key={repoId}
            bot={bot}
            repo={repos.find((repo) => repo.id === repoId)}
            name={repos.find((repo) => repo.id === repoId)?.displayName ?? repoId}
            view={views?.get(repoId)}
            onRemove={() => onChange(linked.filter((id) => id !== repoId))}
          />
        ))}
        <LinkProjectRow bot={bot} repos={repos} linked={linked} onChange={onChange} />
      </div>
    </section>
  )
}
