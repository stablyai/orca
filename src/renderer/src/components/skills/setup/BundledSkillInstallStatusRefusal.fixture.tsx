// Settings › Skills result line after a refused cross-drive backup (item 1126).
import { defineFixture } from '../../../component-fixtures/component-fixture'
import type {
  BundledSkillInstallResult,
  BundledSkillOpOutcome
} from '../../../../../shared/skills/bundled/bundled-skill-plan'
import { summarizeBundledSkillOutcomes } from '../../../../../shared/skills/bundled/bundled-skill-summary'
import type { SkillBackupHost } from '../freshness/skill-backup-location'
import { BundledSkillInstallStatus } from './BundledSkillInstallStatus'

const SKILLS = '/Users/sam/.agents/skills'

function status(
  ops: BundledSkillOpOutcome[],
  others: BundledSkillInstallResult['skills'] = [],
  attention?: { retry: () => void; message?: string },
  backupHost: SkillBackupHost = { kind: 'local' }
): React.JSX.Element {
  const result: BundledSkillInstallResult = {
    scope: 'global',
    skills: [{ name: 'orca-cli', status: 'ran', ops }, ...others]
  }
  const state = {
    kind: 'done' as const,
    result,
    summary: summarizeBundledSkillOutcomes(result),
    backupHost
  }
  return (
    <BundledSkillInstallStatus
      install={{ state, retry: () => {} }}
      {...(attention ? { attention } : {})}
    />
  )
}

const refused = (
  source: 'in-place' | 'leftover' | 'moved-aside',
  path: string,
  fields: Partial<BundledSkillOpOutcome> = {}
): BundledSkillOpOutcome => ({
  path: `${SKILLS}/orca-cli`,
  kind: 'replace',
  status: 'failed',
  error: 'EXDEV',
  backupRefusal: { path, source },
  ...fields
})
const linked: BundledSkillOpOutcome = {
  path: '/Users/sam/.claude/skills/orca-cli',
  kind: 'link',
  status: 'done'
}

function Lines(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4 bg-background p-4">
      {status([refused('in-place', '/Volumes/Work/project/.agents/skills/orca-cli')])}
      {status([refused('in-place', `${SKILLS}/orca-cli`), linked])}
      {status([
        refused('leftover', `${SKILLS}/.orca-cli.orca-old-3f2a9c1e`, {
          kind: 'keep',
          currentConfirmed: true
        })
      ])}
      {status([
        refused('moved-aside', `${SKILLS}/.orca-cli-old.orca-old-5c09b7d2`, {
          kind: 'keep',
          currentConfirmed: true
        })
      ])}
      {status([
        refused('moved-aside', `${SKILLS}/.orca-cli.orca-old-7b1d44e0`, {
          kind: 'update',
          contentApplied: true
        })
      ])}
      {status(
        [refused('in-place', `${SKILLS}/orca-cli`)],
        [
          {
            name: 'orchestration',
            status: 'ran',
            ops: [{ path: `${SKILLS}/orchestration`, kind: 'update', status: 'done' }]
          }
        ]
      )}
    </div>
  )
}

export const states = defineFixture({ render: () => <Lines />, width: 480 })

const LONG = 'orca-cli-orchestration-and-worktree-handoff'
const updated = (name: string): BundledSkillInstallResult['skills'][number] => ({
  name,
  status: 'ran',
  ops: [{ path: `${SKILLS}/${name}`, kind: 'update', status: 'done' }]
})

/** A batch: every refused copy is listed under the one result line. */
function Batch(): React.JSX.Element {
  return (
    <div className="bg-background p-4">
      {status(
        [refused('in-place', `${SKILLS}/orca-cli`)],
        [
          updated('orchestration'),
          {
            name: LONG,
            status: 'ran',
            ops: [
              {
                path: `${SKILLS}/${LONG}`,
                kind: 'keep',
                status: 'failed',
                error: 'EXDEV',
                currentConfirmed: true,
                backupRefusal: {
                  path: `${SKILLS}/.${LONG}.orca-old-0c6e2f19-91aa-4d0b-8f3e-5a2b7c9d1e44`,
                  source: 'moved-aside'
                }
              }
            ]
          },
          updated('electron')
        ]
      )}
    </div>
  )
}

export const batch = defineFixture({ render: () => <Batch />, width: 320 })

const FORMER = `/Users/sam/.gemini/skills/${LONG}`
const putBack = (fields: Partial<BundledSkillOpOutcome>) =>
  refused('in-place', FORMER, {
    backupRefusal: { path: FORMER, source: 'in-place', onlyNotice: true },
    ...fields
  })

/** A retired copy put back in place: updated, or the main copy only rechecked as current. */
function PutBack(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4 bg-background p-4">
      {status([putBack({ kind: 'update', contentApplied: true })])}
      {status([putBack({ kind: 'keep', currentConfirmed: true })])}
    </div>
  )
}

export const putBackLines = defineFixture({ render: () => <PutBack />, width: 320 })

/** After a refresh shows attention, the run's kept and backed-up paths stay below it. */
function AfterRefresh(): React.JSX.Element {
  const backup = `/Users/sam/.agents/.orca-skill-backups/${LONG}-2026-11-23T18-02-11-512Z`
  return (
    <div className="bg-background p-4">
      {status(
        [
          putBack({
            kind: 'update',
            contentApplied: true,
            backupPath: backup,
            backupPaths: [backup]
          })
        ],
        [],
        { retry: () => {}, message: "Needs attention · This copy differs from Orca's" }
      )}
    </div>
  )
}

export const afterRefresh = defineFixture({ render: () => <AfterRefresh />, width: 320 })

/** One skill with a copy no plan will mention again beside an ordinary kept copy: each keeps its own next step. */
function MixedPaths(): React.JSX.Element {
  return (
    <div className="bg-background p-4">
      {status([
        putBack({ kind: 'update', contentApplied: true }),
        refused('in-place', '/Users/sam/.claude/skills/orca-cli', {
          path: '/Users/sam/.claude/skills/orca-cli',
          kind: 'replace'
        })
      ])}
    </div>
  )
}

export const mixedPaths = defineFixture({ render: () => <MixedPaths />, width: 320 })

/** A refused and a backed-up copy on a paired host: both offer Copy path. */
function Remote(): React.JSX.Element {
  const backup = '/Users/sam/.agents/.orca-skill-backups/orca-cli-2026-11-23T18-02-11-512Z'
  return (
    <div className="bg-background p-4">
      {status(
        [
          refused('moved-aside', `${SKILLS}/.orca-cli.orca-old-7b1d44e0`, {
            kind: 'update',
            contentApplied: true,
            backupPath: backup,
            backupPaths: [backup]
          })
        ],
        [],
        undefined,
        { kind: 'remote', name: 'build-box' }
      )}
    </div>
  )
}

export const remote = defineFixture({ render: () => <Remote />, width: 480 })
