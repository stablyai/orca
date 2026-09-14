import type { SkillCloudVersion } from '../../../../shared/skill-cloud-contract'
import { fileCountLabel } from './skill-display-labels'

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
      // Why: the version carries the published name and description; the
      // manifest copy is the fallback for packages that predate them.
      name: version.name || version.manifest.name,
      description: version.description || version.manifest.description,
      files: version.manifest.files
    }
  ]
}

/** Row summary: a simple file count; detailed classifications live in the expanded list. */
export function checklistItemSummary(files: readonly SkillChecklistFile[]): {
  label: string
} {
  return { label: fileCountLabel(files.length) }
}
