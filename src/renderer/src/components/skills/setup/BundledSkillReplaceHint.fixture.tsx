import { Download } from 'lucide-react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import type {
  BundledSkillInstallResult,
  BundledSkillPlan
} from '../../../../../shared/skills/bundled/bundled-skill-plan'
import { Button } from '@/components/ui/button'
import { useIntlLocale } from '@/i18n/use-translate'
import type { BuiltInUiLanguage } from '../../../../../shared/i18n/ui-language'
import { pinFixtureLanguage, waitForFixtureLanguage } from '../skill-fixture-language'
import { BrowserAction } from '../../feature-wall/setup/browser/FeatureWallBrowserAction'
import { BundledSkillInstallStatus } from './BundledSkillInstallStatus'
import { BundledSkillReplaceHint } from './BundledSkillReplaceHint'
import { bundledSkillSetupAttentionMessage } from './bundled-skill-setup-result-copy'
import { summarizeBundledSkillOutcomes } from '../../../../../shared/skills/bundled/bundled-skill-summary'
import { skillBackupLocation, type SkillBackupHost } from '../freshness/skill-backup-location'

const HOME = '/home/dev'
const REMOTE: SkillBackupHost = { kind: 'remote', name: 'build-box' }
const BACKUP = `${HOME}/.agents/.orca-skill-backups/orca-cli-2026-11-22T09-14-03-512Z-4f1c2a9e-7b3d-4e8a-9c21-6d0e5f3b8a17`

function seededPlan(folder: string, replaceable: boolean): BundledSkillPlan {
  return {
    scope: 'global',
    homeDirectory: HOME,
    planDigest: 'b'.repeat(64),
    skills: [
      {
        name: 'orca-cli',
        digest: 'a'.repeat(64),
        ops: [
          {
            kind: 'leave',
            path: `${HOME}/.codex/skills/${folder}`,
            role: 'agent',
            agents: ['codex'],
            observed: {
              kind: 'folder',
              entries: ['SKILL.md:file', 'agents:directory'],
              skillDigest: 'c'.repeat(64)
            },
            cleanup: [],
            reason: 'edited',
            replaceable
          }
        ]
      }
    ]
  }
}

async function openReplaceTooltip(frame: HTMLElement): Promise<void> {
  const deadline = performance.now() + 10_000
  const trigger = await new Promise<Element>((resolve, reject) => {
    const find = (): void => {
      const element = frame.querySelector('[data-slot="tooltip-trigger"]')
      if (element) {
        resolve(element)
      } else if (performance.now() >= deadline) {
        reject(new Error('Replace tooltip trigger did not render'))
      } else {
        requestAnimationFrame(find)
      }
    }
    find()
  })
  trigger.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }))
  await new Promise((resolve) => setTimeout(resolve, 900))
}

function replaceButtonFixture(host: SkillBackupHost) {
  return defineFixture({
    width: 460,
    render: () => (
      <div className="flex h-28 items-end p-3">
        <BundledSkillReplaceHint
          replacing
          action={{ kind: 'replace', paths: [], backup: skillBackupLocation(HOME, host) }}
        >
          <Button type="button" variant="outline" size="sm">
            <Download className="size-3.5" />
            Replace with Orca’s
          </Button>
        </BundledSkillReplaceHint>
      </div>
    ),
    interact: openReplaceTooltip
  })
}

/** Settings' Replace button with its hint open. */
export const replaceButton = replaceButtonFixture({ kind: 'local' })

/** The same button for a paired server: the folder is on that host. */
export const replaceButtonRemote = replaceButtonFixture(REMOTE)

function replacedStatus(host: SkillBackupHost) {
  const result: BundledSkillInstallResult = {
    scope: 'global',
    skills: [
      {
        name: 'orca-cli',
        status: 'ran',
        ops: [
          {
            path: `${HOME}/.agents/skills/orca-cli`,
            kind: 'replace',
            status: 'done',
            backupPath: BACKUP
          }
        ]
      }
    ]
  }
  return defineFixture({
    width: 460,
    render: () => (
      <div className="p-3">
        <BundledSkillInstallStatus
          install={{
            state: {
              kind: 'done',
              result,
              summary: summarizeBundledSkillOutcomes(result),
              backupHost: host
            },
            retry: () => undefined
          }}
        />
      </div>
    )
  })
}

/** Settings after Replace on this computer: the exact backup with Show folder. */
export const replacedResult = replacedStatus({ kind: 'local' })

/** Settings after Replace on a paired server: the exact backup with Copy path. */
export const replacedResultRemote = replacedStatus(REMOTE)

export const featureWallReplace = defineFixture({
  width: 420,
  store: { runtimeEnvironmentCatalogSettled: true },
  setup: () => {
    const { bundledPlan } = window.api.skills
    window.api.skills.bundledPlan = async () => {
      window.api.skills.bundledPlan = bundledPlan
      return seededPlan('orca-cli', true)
    }
  },
  render: () => (
    <div className="flex h-24 items-end p-3">
      <BrowserAction done />
    </div>
  ),
  interact: openReplaceTooltip
})

// Why remount per locale: the message is memoized without the language, so a line first rendered
// before the pinned language applied would keep the earlier one.
function AttentionLine(): React.JSX.Element {
  const locale = useIntlLocale()
  return <AttentionLineInLocale key={locale} />
}

function AttentionLineInLocale(): React.JSX.Element {
  return (
    <div className="p-3">
      <BundledSkillInstallStatus
        install={{ state: { kind: 'idle' }, retry: () => undefined }}
        attention={{
          retry: () => undefined,
          message: bundledSkillSetupAttentionMessage(seededPlan('orca', false))
        }}
      />
    </div>
  )
}

function attentionLineFixture(language: BuiltInUiLanguage = 'en') {
  return defineFixture({
    width: 420,
    render: () => <AttentionLine />,
    setup: () => pinFixtureLanguage(language),
    interact: (frame) => waitForFixtureLanguage(frame, language)
  })
}

/** Settings' line for a copy Orca won't replace (a former skill name). */
export const attentionLine = attentionLineFixture()
/** The longest locales beside Retry at the Settings row width. */
export const attentionLineGerman = attentionLineFixture('de')
export const attentionLineRussian = attentionLineFixture('ru')
