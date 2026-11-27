import { defineFixture } from '../../../component-fixtures/component-fixture'
import type {
  BundledSkillObserved,
  BundledSkillOp,
  BundledSkillOutcome,
  BundledSkillPlan
} from '../../../../../shared/skills/bundled/bundled-skill-plan'
import { summarizeBundledSkillPlan } from '../../../../../shared/skills/bundled/bundled-skill-summary'
import { SkillUpdateRow } from './SkillUpdateRow'
import { useIntlLocale } from '@/i18n/use-translate'
import type { BuiltInUiLanguage } from '../../../../../shared/i18n/ui-language'
import { pinFixtureLanguage, waitForFixtureLanguage } from '../skill-fixture-language'
import { skillBackupLocation, type SkillBackupHost } from './skill-backup-location'

// Seeded data only: a made-up home.
const HOME = '/home/dev'
const NAME = 'orca-cli'
const SHARED = `${HOME}/.agents/skills/${NAME}`
const FORMER = `${HOME}/.codex/skills/orca`
const LOCAL: SkillBackupHost = { kind: 'local' }
const REMOTE: SkillBackupHost = { kind: 'remote', name: 'build-box' }
const BACKUP = `${HOME}/.agents/.orca-skill-backups/${NAME}-2026-11-22T09-14-03-512Z-4f1c2a9e-7b3d-4e8a-9c21-6d0e5f3b8a17`
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

// Why remount per locale: the row's reason lines are memoized on the location, not the language,
// so a row first rendered before the pinned language applied would keep the earlier one.
function LocalizedRow({
  plan,
  ...props
}: { plan: BundledSkillPlan } & Omit<
  React.ComponentProps<typeof SkillUpdateRow>,
  'skill'
>): React.JSX.Element {
  const locale = useIntlLocale()
  return (
    <SkillUpdateRow key={locale} skill={summarizeBundledSkillPlan(plan).skills[0]} {...props} />
  )
}

function rowFixture(
  ops: BundledSkillOp[],
  replaced = false,
  width = 576,
  host: SkillBackupHost = LOCAL,
  outcome?: BundledSkillOutcome,
  language: BuiltInUiLanguage = 'en'
) {
  const plan: BundledSkillPlan = {
    scope: 'global',
    homeDirectory: HOME,
    skills: [{ name: NAME, digest: 'a'.repeat(64), ops }],
    planDigest: 'b'.repeat(64)
  }
  return defineFixture({
    width,
    render: () => (
      <div className="px-3">
        <LocalizedRow
          plan={plan}
          phase={outcome ? 'result' : 'plan'}
          showLocations={!outcome}
          replace={{ isReplaced: () => replaced, onReplaceChange: () => undefined }}
          backup={skillBackupLocation(HOME, host)}
          {...(outcome ? { outcome } : {})}
        />
      </div>
    ),
    setup: () => pinFixtureLanguage(language),
    interact: (frame) => waitForFixtureLanguage(frame, language)
  })
}

/** An older Orca release whose folder also holds agents/: the case that used to read "edited". */
export const olderReleaseWithExtras = rowFixture([leave(SHARED, WITH_EXTRAS, {})])

export const olderReleaseNarrow = rowFixture([leave(SHARED, WITH_EXTRAS, {})], false, 400)

/** The same folder after Replace is checked: the dialog shows the forced plan's replace. */
export const olderReleaseReplaceChecked = rowFixture(
  [leave(SHARED, WITH_EXTRAS, { kind: 'replace', content: 'files', reason: undefined })],
  true
)

/** The same choice on a paired server: the folder is named on that host. */
export const olderReleaseRemote = rowFixture([leave(SHARED, WITH_EXTRAS, {})], false, 576, REMOTE)

const REPLACED: BundledSkillOutcome = {
  name: NAME,
  status: 'ran',
  ops: [{ path: SHARED, kind: 'replace', status: 'done', backupPath: BACKUP }]
}

/** After Replace on this computer: the exact backup with Show folder. */
export const replacedResult = rowFixture(
  [leave(SHARED, WITH_EXTRAS, { kind: 'keep', reason: undefined })],
  false,
  576,
  LOCAL,
  REPLACED
)

/** After Replace on a paired server: the exact backup on that host with Copy path. */
export const replacedResultRemote = rowFixture(
  [leave(SHARED, WITH_EXTRAS, { kind: 'keep', reason: undefined })],
  false,
  576,
  REMOTE,
  REPLACED
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

export const fileCopy = rowFixture([
  leave(SHARED, { kind: 'file', mtimeMs: 0 }, { reason: 'other' })
])

/** A copy under a former skill name stays visible and is never offered for Replace. */
export const formerNameCopy = rowFixture([
  leave(FORMER, WITH_EXTRAS, { role: 'agent', agents: ['codex'], replaceable: false })
])

// Long locales at the dialog's narrow width: the backup lines must wrap, not clip.
const KEEP = [leave(SHARED, WITH_EXTRAS, { kind: 'keep', reason: undefined })]
export const olderReleaseRemoteGerman = rowFixture(
  [leave(SHARED, WITH_EXTRAS, {})],
  false,
  400,
  REMOTE,
  undefined,
  'de'
)
export const olderReleaseRemoteRussian = rowFixture(
  [leave(SHARED, WITH_EXTRAS, {})],
  false,
  400,
  REMOTE,
  undefined,
  'ru'
)
export const replacedResultRemoteGerman = rowFixture(KEEP, false, 400, REMOTE, REPLACED, 'de')
export const replacedResultRemoteRussian = rowFixture(KEEP, false, 400, REMOTE, REPLACED, 'ru')
