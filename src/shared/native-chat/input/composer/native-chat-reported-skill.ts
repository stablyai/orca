import type { DiscoveredSkill } from '../../../skills/discovery/skills'
import type { NativeChatSessionSkill } from '../commands/native-chat-slash-commands'
import type { NativeChatPickerItem } from './native-chat-picker-items'
import { isSafeDisplayText, stripUnsafeDisplayCharacters } from '../../../text/display-text-safety'

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
    ...argumentHintCopy(skill),
    sources: scanned ? [{ sourceKind: scanned.sourceKind, skillFilePath: path }] : [],
    path,
    ...(duplicate ? { location: stripUnsafeDisplayCharacters(path).slice(0, 4096) } : {})
  }
}

type ReportedSkillCopy = Pick<NativeChatSessionSkill, 'description' | 'argumentHint'>

function argumentHintCopy(reported: ReportedSkillCopy | undefined): { argumentHint?: string } {
  const hint = reported?.argumentHint
    ? stripUnsafeDisplayCharacters(reported.argumentHint).slice(0, 80)
    : ''
  return hint ? { argumentHint: hint } : {}
}

export function withReportedSkillCopy(
  skill: Extract<NativeChatPickerItem, { kind: 'skill' }>,
  reported: ReportedSkillCopy | undefined
): Extract<NativeChatPickerItem, { kind: 'skill' }> {
  const description =
    skill.description ??
    (reported?.description
      ? stripUnsafeDisplayCharacters(reported.description).slice(0, 240)
      : null)
  return { ...skill, description, ...argumentHintCopy(reported) }
}

// Names are inserted PTY tokens, never visual prefixes. CSS truncates display; reject unsafe lengths without slicing tokens.
const MAX_TOKEN_SAFE_NAME_LENGTH = 200

export function getSafeSkillName(skill: DiscoveredSkill): string | null {
  if (isTokenSafe(skill.name)) {
    return skill.name
  }
  const directoryName = skillDirectoryName(skill)
  return isTokenSafe(directoryName) ? directoryName : null
}

export function skillDirectoryName(skill: Pick<DiscoveredSkill, 'directoryPath'>): string {
  return skill.directoryPath.split(/[\\/]/).findLast(Boolean) ?? ''
}

export function isTokenSafe(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_TOKEN_SAFE_NAME_LENGTH &&
    !/\s/u.test(value) &&
    isSafeDisplayText(value)
  )
}
