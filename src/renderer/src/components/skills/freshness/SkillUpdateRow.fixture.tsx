import { defineFixture } from '../../../component-fixtures/component-fixture'
import type {
  BundledSkillObserved,
  BundledSkillOp,
  BundledSkillPlan
} from '../../../../../shared/skills/bundled/bundled-skill-plan'
import { summarizeBundledSkillPlan } from '../../../../../shared/skills/bundled/bundled-skill-summary'
import { SkillUpdateRow } from './SkillUpdateRow'

// Seeded data only: a made-up home.
const HOME = '/home/dev'
const NAME = 'orca-cli'
const SHARED = `${HOME}/.agents/skills/${NAME}`
const FORMER = `${HOME}/.codex/skills/orca`
const WITH_EXTRAS: BundledSkillObserved = {
  kind: 'folder',
  entries: ['SKILL.md:file', 'agents:directory'],
  skillDigest: 'c'.repeat(64)
}
const SKILL_ONLY: BundledSkillObserved = {
  kind: 'folder',
  entries: ['SKILL.md:file'],
  skillDigest: 'e'.repeat(64)
}

function leave(path: string, observed: BundledSkillObserved, extra: Partial<BundledSkillOp>) {
  return {
    kind: 'leave',
    path,
    role: 'shared',
    agents: [],
    observed,
    cleanup: [],
    reason: 'edited',
    replaceable: true,
    ...extra
  } satisfies BundledSkillOp
}

function rowFixture(ops: BundledSkillOp[], replaced = false) {
  const plan: BundledSkillPlan = {
    scope: 'global',
    homeDirectory: HOME,
    skills: [{ name: NAME, digest: 'a'.repeat(64), ops }],
    planDigest: 'b'.repeat(64)
  }
  const skill = summarizeBundledSkillPlan(plan).skills[0]
  return defineFixture({
    width: 576,
    render: () => (
      <div className="px-3">
        <SkillUpdateRow
          skill={skill}
          phase="plan"
          showLocations
          replace={{ isReplaced: () => replaced, onReplaceChange: () => undefined }}
        />
      </div>
    )
  })
}

/** An older Orca release whose folder also holds agents/: the case that used to read "edited". */
export const olderReleaseWithExtras = rowFixture([leave(SHARED, WITH_EXTRAS, {})])

/** The same folder after Replace is checked: the dialog shows the forced plan's replace. */
export const olderReleaseReplaceChecked = rowFixture(
  [leave(SHARED, WITH_EXTRAS, { kind: 'replace', content: 'files', reason: undefined })],
  true
)

/** A real edit to SKILL.md: the same neutral reason, because Orca can't tell the cases apart. */
export const realEdit = rowFixture([leave(SHARED, SKILL_ONLY, {})])

/** A link that Replace would move by itself: no whole-folder line. */
export const linkCopy = rowFixture([
  leave(
    `${HOME}/.claude/skills/${NAME}`,
    { kind: 'link', target: '/opt/skills/orca-cli' },
    {
      role: 'agent',
      agents: ['claude'],
      reason: 'other'
    }
  )
])

/** A copy under a former skill name stays visible and is never offered for Replace. */
export const formerNameCopy = rowFixture([
  leave(FORMER, WITH_EXTRAS, { role: 'agent', agents: ['codex'], replaceable: false })
])
