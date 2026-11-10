import type { DiscoveredSkill } from '../skills'
import type { NativeChatSessionSkill } from './input/native-chat-slash-commands'
import type { NativeChatPickerItem } from './input/native-chat-picker-items'
import { isSafeDisplayCharacter, stripUnsafeDisplayCharacters } from '../display-text-safety'

export function locatedPickerSkill(
  skill: NativeChatSessionSkill,
  path: string,
  scanned: DiscoveredSkill | undefined,
  skillSigil: '/' | '$',
  duplicate: boolean
): Extract<NativeChatPickerItem, { kind: 'skill' }> {
  const description = skill.description ?? scanned?.description
  const argumentHint = skill.argumentHint
    ? stripUnsafeDisplayCharacters(skill.argumentHint).slice(0, 80)
    : ''
  return {
    kind: 'skill',
    id: `skill:${path}`,
    name: skill.name,
    token: `${skillSigil}${skill.name}`,
    description: description ? stripUnsafeDisplayCharacters(description).slice(0, 240) : null,
    ...(argumentHint ? { argumentHint } : {}),
    sources: scanned ? [{ sourceKind: scanned.sourceKind, skillFilePath: path }] : [],
    path,
    ...(duplicate ? { location: stripUnsafeDisplayCharacters(path).slice(0, 4096) } : {})
  }
}

function reportedPickerText(value: string, maxLength: number): string {
  return stripUnsafeDisplayCharacters(value).slice(0, maxLength)
}

export function withReportedSkillCopy(
  skill: Extract<NativeChatPickerItem, { kind: 'skill' }>,
  reported: NativeChatSessionSkill | undefined
): Extract<NativeChatPickerItem, { kind: 'skill' }> {
  const description =
    skill.description === null && reported?.description
      ? reportedPickerText(reported.description, 240)
      : skill.description
  const argumentHint = reported?.argumentHint ? reportedPickerText(reported.argumentHint, 80) : ''
  return argumentHint ? { ...skill, description, argumentHint } : { ...skill, description }
}

// Names are inserted PTY tokens, never visual prefixes. CSS truncates display; reject unsafe lengths without slicing tokens.
const MAX_TOKEN_SAFE_NAME_LENGTH = 200

export function getSafeSkillName(skill: DiscoveredSkill): string | null {
  if (isTokenSafe(skill.name)) {
    return skill.name
  }
  const directoryName = skill.directoryPath.split(/[\\/]/).findLast(Boolean) ?? ''
  return isTokenSafe(directoryName) ? directoryName : null
}

export function isTokenSafe(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_TOKEN_SAFE_NAME_LENGTH &&
    !/\s/u.test(value) &&
    [...value].every(isSafeDisplayCharacter)
  )
}
