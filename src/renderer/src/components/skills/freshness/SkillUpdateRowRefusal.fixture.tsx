// Update dialog result rows when a cross-drive backup was refused (item 1126 states S1–S5).
import { defineFixture } from '../../../component-fixtures/component-fixture'
import type {
  BundledSkillOpOutcome,
  BundledSkillOutcome
} from '../../../../../shared/skills/bundled/bundled-skill-plan'
import type { BundledSkillPlanSkillSummary } from '../../../../../shared/skills/bundled/bundled-skill-summary'
import { SkillUpdateRow } from './SkillUpdateRow'
import { skillBackupLocation, type SkillBackupLocation } from './skill-backup-location'

const SKILLS = '/Users/sam/.agents/skills'
const LOCAL = skillBackupLocation('/Users/sam', { kind: 'local' })
const REMOTE = skillBackupLocation('/Users/sam', { kind: 'remote', name: 'build-box' })

function row(
  name: string,
  ops: BundledSkillOpOutcome[],
  backup: SkillBackupLocation
): React.JSX.Element {
  const skill: BundledSkillPlanSkillSummary = {
    name,
    state: 'update',
    locations: [],
    upToDate: false
  }
  const outcome: BundledSkillOutcome = { name, status: 'ran', ops }
  return (
    <SkillUpdateRow
      skill={skill}
      phase="result"
      outcome={outcome}
      showLocations={false}
      backup={backup}
    />
  )
}

const refused = (
  name: string,
  source: 'in-place' | 'leftover' | 'moved-aside',
  path: string,
  fields: Partial<BundledSkillOpOutcome> = {}
): BundledSkillOpOutcome => ({
  path: `${SKILLS}/${name}`,
  kind: 'replace',
  status: 'failed',
  error: 'EXDEV',
  backupRefusal: { path, source },
  ...fields
})

const LONG = 'orca-cli-orchestration-and-worktree-handoff'
const REVIEW_BACKUP =
  '/Users/sam/.agents/.orca-skill-backups/orca-review-2026-11-24T10-00-00-000Z-1'
const FORMER_ROOT_COPY = `/Users/sam/.gemini/skills/.${LONG}.orca-old-0c6e2f19-91aa-4d0b-8f3e-5a2b7c9d1e44`
const linked = (name: string): BundledSkillOpOutcome => ({
  path: `/Users/sam/.claude/skills/${name}`,
  kind: 'link',
  status: 'done'
})

function Rows({ backup }: { backup: SkillBackupLocation }): React.JSX.Element {
  return (
    <div className="bg-background px-4">
      {row(
        'orca-cli',
        [refused('orca-cli', 'in-place', '/Volumes/Work/project/.agents/skills/orca-cli')],
        backup
      )}
      {row(
        'orchestration',
        [refused('orchestration', 'in-place', `${SKILLS}/orchestration`), linked('orchestration')],
        backup
      )}
      {row(
        'orca-linear',
        [
          refused('orca-linear', 'leftover', `${SKILLS}/.orca-linear.orca-old-3f2a9c1e`, {
            kind: 'keep',
            currentConfirmed: true
          }),
          linked('orca-linear')
        ],
        backup
      )}
      {row(
        'orca-plan',
        [
          refused('orca-plan', 'moved-aside', `${SKILLS}/.orca-planner.orca-old-5c09b7d2`, {
            kind: 'keep',
            currentConfirmed: true
          })
        ],
        backup
      )}
      {row(
        'gemini-former',
        [
          refused('gemini-former', 'in-place', '/Users/sam/.gemini/skills/gemini-former', {
            kind: 'write',
            contentApplied: true,
            backupRefusal: {
              path: '/Users/sam/.gemini/skills/gemini-former',
              source: 'in-place',
              onlyNotice: true
            }
          })
        ],
        backup
      )}
      {row(
        'electron',
        [
          refused('electron', 'moved-aside', `${SKILLS}/.electron.orca-old-7b1d44e0`, {
            kind: 'update',
            contentApplied: true,
            strandedPath: `${SKILLS}/.electron.orca-old-7b1d44e0`
          })
        ],
        backup
      )}
      {row(
        'orca-review',
        [
          refused('orca-review', 'moved-aside', `${SKILLS}/.orca-review.orca-old-2e8f`, {
            kind: 'update',
            contentApplied: true,
            backupPath: REVIEW_BACKUP,
            backupPaths: [REVIEW_BACKUP]
          })
        ],
        backup
      )}
      {row(
        LONG,
        [
          {
            path: `${SKILLS}/${LONG}`,
            kind: 'write',
            status: 'failed',
            error: 'EXDEV',
            contentApplied: true,
            backupRefusal: { path: FORMER_ROOT_COPY, source: 'moved-aside', onlyNotice: true }
          },
          linked(LONG)
        ],
        backup
      )}
    </div>
  )
}

export const states = defineFixture({ render: () => <Rows backup={LOCAL} />, width: 640 })
export const narrow = defineFixture({ render: () => <Rows backup={LOCAL} />, width: 420 })
export const remote = defineFixture({ render: () => <Rows backup={REMOTE} />, width: 640 })
