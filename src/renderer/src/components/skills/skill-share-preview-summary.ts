import type { SkillSharePreview } from '../../../../shared/skill-sharing-contract'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export function byteLabel(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function scriptCountLabel(count: number, t: Translate = translate): string {
  return t('auto.components.skills.share.script', '{{count}} scripts', {
    count,
    defaultValue_one: '{{count}} script'
  })
}

function executableCountLabel(count: number, t: Translate = translate): string {
  return t('auto.components.skills.share.executable', '{{count}} executables', {
    count,
    defaultValue_one: '{{count}} executable'
  })
}

export type SkillShareRiskSummary = { risky: boolean; label: string }

/** Name executable/script content explicitly; omit empty counts. */
export function summarizeExecutableContent(
  scriptCount: number,
  executableCount: number,
  t: Translate = translate
): SkillShareRiskSummary {
  const parts: string[] = []
  if (scriptCount > 0) {
    parts.push(scriptCountLabel(scriptCount, t))
  }
  if (executableCount > 0) {
    parts.push(executableCountLabel(executableCount, t))
  }
  return parts.length === 0
    ? {
        risky: false,
        label: t('auto.components.skills.share.noExecutableContent', 'No scripts or executables')
      }
    : { risky: true, label: parts.join(', ') }
}

export function summarizeShareRisk(
  preview: SkillSharePreview,
  t?: Translate
): SkillShareRiskSummary {
  return summarizeExecutableContent(preview.scriptPaths.length, preview.executablePaths.length, t)
}

export type SkillShareSensitiveFile = { path: string; script: boolean; executable: boolean }

/** Preview exposes script/executable paths only, not the full package file list. */
export function sensitiveShareFiles(preview: SkillSharePreview): SkillShareSensitiveFile[] {
  const scripts = new Set(preview.scriptPaths)
  const executables = new Set(preview.executablePaths)
  return [...new Set([...preview.scriptPaths, ...preview.executablePaths])]
    .sort((left, right) => left.localeCompare(right))
    .map((path) => ({ path, script: scripts.has(path), executable: executables.has(path) }))
}
