import type { DiscoveredSkill } from './skills'
import type { NativeChatSessionSkill } from './native-chat-slash-commands'
import type { NativeChatPickerItem } from './native-chat-picker-items'
import { stripUnsafeDisplayCharacters } from './skill-display-text'

export function locatedPickerSkill(
  skill: NativeChatSessionSkill,
  path: string,
  scanned: DiscoveredSkill | undefined,
  skillSigil: '/' | '$',
  duplicate: boolean
): Extract<NativeChatPickerItem, { kind: 'skill' }> {
  const description = skill.description ?? scanned?.description
  return {
    kind: 'skill',
    id: `skill:${path}`,
    name: skill.name,
    token: `${skillSigil}${skill.name}`,
    description: description ? stripUnsafeDisplayCharacters(description).slice(0, 240) : null,
    sources: scanned ? [{ sourceKind: scanned.sourceKind, skillFilePath: path }] : [],
    path,
    ...(duplicate ? { location: stripUnsafeDisplayCharacters(path).slice(0, 4096) } : {})
  }
}
