import type { DiscoveredSkill } from '../../../../shared/skills'
import { DiscoveredSkillCard } from './DiscoveredSkillCard'

function countSkillNames(skills: readonly DiscoveredSkill[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const skill of skills) {
    const key = skill.name.trim().toLowerCase()
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

export function SkillsGalleryGrid({
  skills
}: {
  skills: readonly DiscoveredSkill[]
}): React.JSX.Element {
  const nameCounts = countSkillNames(skills)

  return (
    <div
      className="mx-auto grid max-w-6xl grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))] gap-3"
      data-testid="skills-gallery-grid"
    >
      {skills.map((skill) => (
        <DiscoveredSkillCard
          key={skill.id}
          skill={skill}
          duplicateCount={nameCounts.get(skill.name.trim().toLowerCase()) ?? 1}
        />
      ))}
    </div>
  )
}
