import type { DiscoveredSkill, SkillSourceKind } from '../../../skills/discovery/skills'
import type { NativeChatPickerItem } from './native-chat-picker-items'
import { compareBaseSensitivityLocaleText } from '../../../i18n/locale-text-collators'

const SCOPE_PRIORITY: Record<SkillSourceKind, number> = {
  repo: 0,
  home: 1,
  bundled: 2,
  plugin: 3
}

export function compareDiscoveredSkills(a: DiscoveredSkill, b: DiscoveredSkill): number {
  return (
    SCOPE_PRIORITY[a.sourceKind] - SCOPE_PRIORITY[b.sourceKind] ||
    compareBaseSensitivityLocaleText(a.name, b.name) ||
    a.skillFilePath.localeCompare(b.skillFilePath)
  )
}

// Unlocated reported skills remain invocable but lack description/scope for ranking; sort last.
const UNLOCATED_SCOPE_PRIORITY = Object.keys(SCOPE_PRIORITY).length

function skillScopePriority(item: Extract<NativeChatPickerItem, { kind: 'skill' }>): number {
  const sourceKind = item.sources[0]?.sourceKind
  return sourceKind === undefined ? UNLOCATED_SCOPE_PRIORITY : SCOPE_PRIORITY[sourceKind]
}

export function comparePickerSkills(
  a: Extract<NativeChatPickerItem, { kind: 'skill' }>,
  b: Extract<NativeChatPickerItem, { kind: 'skill' }>
): number {
  return (
    skillScopePriority(a) - skillScopePriority(b) ||
    compareBaseSensitivityLocaleText(a.name, b.name)
  )
}

// Budget the unfiltered list across scopes, then retain its existing display order.
export function limitSkillsAcrossScopes(
  skills: Extract<NativeChatPickerItem, { kind: 'skill' }>[],
  limit: number
): Extract<NativeChatPickerItem, { kind: 'skill' }>[] {
  if (skills.length <= limit) {
    return skills
  }
  const byScope = new Map<
    SkillSourceKind | undefined,
    Extract<NativeChatPickerItem, { kind: 'skill' }>[]
  >()
  for (const skill of skills) {
    const scope = skill.sources[0]?.sourceKind
    const queue = byScope.get(scope)
    if (queue) {
      queue.push(skill)
    } else {
      byScope.set(scope, [skill])
    }
  }
  const queues = [...byScope.values()]
  const picked = new Set<NativeChatPickerItem>()
  for (let depth = 0; picked.size < limit; depth += 1) {
    let advanced = false
    for (const queue of queues) {
      if (picked.size >= limit) {
        break
      }
      const next = queue[depth]
      if (next) {
        picked.add(next)
        advanced = true
      }
    }
    if (!advanced) {
      break
    }
  }
  return skills.filter((skill) => picked.has(skill))
}
