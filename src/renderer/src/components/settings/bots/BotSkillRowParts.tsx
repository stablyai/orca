// The pieces Settings › Skills rows share: a skill count, a row with nothing to open, a skill list
// and a folder line with Open folder.
import React, { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'

const SHOWN_SKILLS = 5

export function skillCount(count: number): string {
  return translate('settings.bots.skills.count', '{{count}} skills', {
    count,
    defaultValue_one: '{{count}} skill'
  })
}

/** A row that never opens: a project with nothing to list. */
export function PlainRow(props: {
  icon: React.ReactNode
  name: string
  description: string
  trailing: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
        {props.icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{props.name}</p>
        <p className="text-xs text-muted-foreground">{props.description}</p>
      </div>
      {props.trailing}
    </div>
  )
}

/** `id` tells two skills of one name apart. */
export type ListedSkill = { id: string; name: string; description: string | null; label?: string }

export function SkillList({ skills }: { skills: readonly ListedSkill[] }): React.JSX.Element {
  const t = useTranslate()
  const [all, setAll] = useState(false)
  const hidden = all ? 0 : Math.max(0, skills.length - SHOWN_SKILLS)
  return (
    <>
      <ul className="flex flex-col gap-0.5">
        {(all ? skills : skills.slice(0, SHOWN_SKILLS)).map((skill) => (
          <li key={skill.id} className="flex h-7 min-w-0 items-center gap-2 text-sm">
            <span className="shrink-0 font-mono text-xs">{skill.name}</span>
            {skill.label ? <Badge variant="referenceLabel">{skill.label}</Badge> : null}
            {skill.description ? (
              <span className="truncate text-xs text-muted-foreground">{skill.description}</span>
            ) : null}
          </li>
        ))}
      </ul>
      {hidden > 0 ? (
        <Button variant="ghost" size="xs" className="mt-1" onClick={() => setAll(true)}>
          {t('settings.bots.skills.showMore', 'Show {{count}} more', { count: hidden })}
        </Button>
      ) : null}
    </>
  )
}

/** The folder on the bot's host; only a folder on this computer opens here. */
export function FolderLine(props: {
  folder: string
  hostId: ExecutionHostId
  children?: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="mt-3 flex items-center gap-2">
      <p className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
        {props.folder}
      </p>
      {props.hostId === LOCAL_EXECUTION_HOST_ID ? (
        <Button
          variant="ghost"
          size="xs"
          onClick={() => void window.api.shell.openPath(props.folder, LOCAL_EXECUTION_HOST_ID)}
        >
          {t('settings.bots.skills.openFolder', 'Open folder')}
        </Button>
      ) : null}
      {props.children}
    </div>
  )
}
