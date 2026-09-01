import { translate } from '@/i18n/i18n'
import type {
  SkillDeleteBlockReason,
  SkillDeletePlan,
  SkillDeleteResultEntry
} from '../../../../shared/skill-delete-contract'

export function skillDeleteBlockReasonLabel(reason: SkillDeleteBlockReason): string {
  switch (reason) {
    case 'bundled': {
      return translate(
        'auto.components.skills.SkillDelete.reasonBundled',
        'Bundled with Orca — it would be restored'
      )
    }
    case 'plugin': {
      return translate(
        'auto.components.skills.SkillDelete.reasonPlugin',
        'Installed by a plugin — remove the plugin instead'
      )
    }
    case 'unowned': {
      return translate(
        'auto.components.skills.SkillDelete.reasonUnowned',
        'This skill lives outside Orca’s skill folders — delete it where it is stored'
      )
    }
    case 'missing': {
      return translate(
        'auto.components.skills.SkillDelete.reasonMissing',
        'This skill is no longer on disk'
      )
    }
    case 'stale': {
      return translate(
        'auto.components.skills.SkillDelete.reasonStale',
        'This skill changed since the list was loaded — refresh and try again'
      )
    }
  }
}

export function skillDeleteActionLabel(count: number): string {
  return count === 1
    ? translate('auto.components.skills.count.deleteOne', 'Delete {{count}} skill', { count })
    : translate('auto.components.skills.count.deleteOther', 'Delete {{count}} skills', { count })
}

function foldersLabel(count: number): string {
  return count === 1
    ? translate('auto.components.skills.count.deleteFolderOne', '{{count}} folder', { count })
    : translate('auto.components.skills.count.deleteFolderOther', '{{count}} folders', { count })
}

function linksLabel(count: number): string {
  return count === 1
    ? translate('auto.components.skills.count.deleteLinkOne', '{{count}} link', { count })
    : translate('auto.components.skills.count.deleteLinkOther', '{{count}} links', { count })
}

/** "Removes 12 folders and 5 links across Claude, Codex, Agent Skills."
 *  Null when the plan removes nothing, so the caller states that instead of
 *  rendering "0 folders and 0 links across " with an empty tail. Zero-valued
 *  halves are dropped: a link-only delete must not read "0 folders and 1 links". */
export function skillDeletePlacementSummary(plan: SkillDeletePlan): string | null {
  const placements = plan.skills.flatMap((skill) => skill.placements)
  if (placements.length === 0) {
    return null
  }
  const folders = placements.filter((placement) => placement.kind === 'canonical').length
  const links = placements.length - folders
  const parts = [
    folders > 0 ? foldersLabel(folders) : null,
    links > 0 ? linksLabel(links) : null
  ].filter((part): part is string => part !== null)
  const roots = [...new Set(placements.map((placement) => placement.rootLabel))].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' })
  )
  return translate(
    'auto.components.skills.SkillDelete.placementSummaryParts',
    'Removes {{parts}} across {{roots}}.',
    {
      parts: parts.join(translate('auto.components.skills.SkillDelete.placementJoin', ' and ')),
      roots: roots.join(', ')
    }
  )
}

/**
 * Not `node:path`: the renderer may be showing a Windows host's paths from macOS,
 * so `dirname` would pick the wrong separator. Both separators are honoured, and
 * a root keeps its trailing one — `/SKILL.md` is `/`, `C:\SKILL.md` is `C:\`.
 */
function parentDirectory(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (index < 0) {
    return path
  }
  const isDriveRoot = index === 2 && path[1] === ':'
  return index === 0 || isDriveRoot ? path.slice(0, index + 1) : path.slice(0, index)
}

/**
 * A skill whose content lives outside every Orca root is removed by its links
 * only. Saying so is the difference between "deleted" and "gone" — the content
 * survives at its source, and the user has to be told which one happened.
 */
export function skillDeleteRetainedSourceLines(plan: SkillDeletePlan): string[] {
  return plan.skills
    .filter(
      (skill) =>
        skill.placements.length > 0 &&
        !skill.placements.some((placement) => placement.kind === 'canonical')
    )
    .map((skill) =>
      translate(
        'auto.components.skills.SkillDelete.retainedSource',
        'The skill itself stays at {{path}}.',
        { path: parentDirectory(skill.canonicalPath) }
      )
    )
}

export function skillDeleteNothingToDoLabel(count: number): string {
  return count === 1
    ? translate(
        'auto.components.skills.SkillDelete.nothingOne',
        'That skill cannot be deleted from here.'
      )
    : translate(
        'auto.components.skills.SkillDelete.nothingOther',
        'None of the {{count}} selected skills can be deleted from here.',
        { count }
      )
}

/** One line per skip reason rather than one merged "skipped" line: the plan
 *  already carries a typed reason per skill, so the dialog groups by it. */
export function skillDeleteBlockedLines(plan: SkillDeletePlan): string[] {
  const counts = new Map<SkillDeleteBlockReason, number>()
  for (const skill of plan.skills) {
    if (skill.blocked) {
      counts.set(skill.blocked, (counts.get(skill.blocked) ?? 0) + 1)
    }
  }
  return [...counts].map(([reason, count]) =>
    translate('auto.components.skills.SkillDelete.blockedLine', '{{count}} × {{reason}}', {
      count,
      reason: skillDeleteBlockReasonLabel(reason)
    })
  )
}

export type SkillDeleteResultLine = { key: string; label: string }

/** A toast disappears before a user can act on "3 failed", so anything that is
 *  not `deleted` gets a persistent, per-reason line instead. */
export function skillDeleteResultLines(
  skills: readonly SkillDeleteResultEntry[]
): SkillDeleteResultLine[] {
  const grouped = new Map<string, { count: number; label: string }>()
  for (const skill of skills) {
    if (skill.status === 'deleted') {
      continue
    }
    const key =
      skill.status === 'skipped' && skill.blocked ? `skipped:${skill.blocked}` : skill.status
    const existing = grouped.get(key)
    grouped.set(key, {
      count: (existing?.count ?? 0) + 1,
      label: existing?.label ?? statusLabel(skill)
    })
  }
  return [...grouped].map(([key, value]) => ({
    key,
    label: translate('auto.components.skills.SkillDelete.resultLine', '{{count}} × {{label}}', {
      count: value.count,
      label: value.label
    })
  }))
}

function statusLabel(skill: SkillDeleteResultEntry): string {
  switch (skill.status) {
    case 'skipped': {
      return skill.blocked
        ? skillDeleteBlockReasonLabel(skill.blocked)
        : translate('auto.components.skills.SkillDelete.statusSkipped', 'Skipped')
    }
    case 'busy': {
      return translate(
        'auto.components.skills.SkillDelete.statusBusy',
        'Busy — another skill operation is in progress'
      )
    }
    case 'partial': {
      return translate(
        'auto.components.skills.SkillDelete.statusPartial',
        'Partly removed — some files are still on disk under a hidden name'
      )
    }
    case 'failed': {
      return translate(
        'auto.components.skills.SkillDelete.statusFailed',
        'Failed — nothing changed'
      )
    }
    case 'deleted': {
      return translate('auto.components.skills.SkillDelete.statusDeleted', 'Deleted')
    }
  }
}
