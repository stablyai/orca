import type { SkillCloudVersion } from '../../../../../shared/skill-cloud-contract'
import { fileCountLabel } from '../presentation/skill-display-labels'
import type { Translate } from '../../../i18n/use-translate'

export type SkillChecklistFile = {
  path: string
  size: number
  executable: boolean
  classification: 'text' | 'binary'
}

export type SkillChecklistItem = {
  id: string
  name: string
  description: string
  files: readonly SkillChecklistFile[]
}

/** One shape for both package kinds: a single skill is a one-item checklist. */
export function checklistItemsFromVersion(version: SkillCloudVersion): SkillChecklistItem[] {
  if ('skills' in version.manifest) {
    return version.manifest.skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      files: skill.files
    }))
  }
  return [
    {
      id: version.manifest.name,
      // Prefer published version metadata; older packages fall back to manifest fields.
      name: version.name || version.manifest.name,
      description: version.description || version.manifest.description,
      files: version.manifest.files
    }
  ]
}

export function checklistItemSummary(
  files: readonly SkillChecklistFile[],
  t?: Translate
): {
  label: string
} {
  return { label: fileCountLabel(files.length, t) }
}
