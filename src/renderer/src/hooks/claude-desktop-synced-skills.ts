import type { DiscoveredSkill } from '../../../shared/skills'

type SkillPlacement = Pick<DiscoveredSkill, 'sourceKind' | 'rootPath' | 'directoryPath'>

function normalizeSkillPath(pathValue: string): string {
  return pathValue.replace(/\\/g, '/').replace(/\/+$/, '')
}

// Why: the Claude desktop app keeps its own skills in `<root>/synced/<bucket>/<name>`; they are not installs.
export function isClaudeDesktopSyncedSkill(skill: SkillPlacement): boolean {
  if (skill.sourceKind !== 'home') {
    return false
  }
  const rootPath = normalizeSkillPath(skill.rootPath)
  const directoryPath = normalizeSkillPath(skill.directoryPath)
  if (!directoryPath.startsWith(`${rootPath}/`)) {
    return false
  }
  const segments = directoryPath.slice(rootPath.length + 1).split('/')
  return segments.length >= 3 && segments[0] === 'synced'
}
