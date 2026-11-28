// The Automation screen's own notices, beside the ones the page shows too. Disabled controls point
// at them with aria-describedby, so each has a stable id.
import { useId } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../shared/bot-types'
import type { AutomationDetailNotice } from '../automations/details/automation-detail-sections'
import type { AutomationDetailsController } from '../automations/details/automation-details-controller'
import type { AutomationDetailsSnapshot } from '../automations/details/automation-details-model'

type NoticeIds = {
  offline: string
  checking: string
  oldHost: string
  foreign: string
  running: string
}

function Action({ label, onPress }: { label: string; onPress: () => void }): React.JSX.Element {
  return (
    <Button type="button" variant="outline" size="xs" className="shrink-0" onClick={onPress}>
      {label}
    </Button>
  )
}

export function useBotAutomationNotices({
  bot,
  hostName,
  offlineHostName,
  snapshot,
  controller,
  offline,
  oldHost,
  running,
  runningAction,
  wontFire,
  onRetired
}: {
  bot: Bot
  hostName: string
  offlineHostName: string
  snapshot: AutomationDetailsSnapshot
  controller: AutomationDetailsController
  offline: boolean
  /** The host is too old: to read or act on this automation, or only to edit its settings here. */
  oldHost: boolean
  running: boolean
  runningAction: { label: string; onOpen: () => void } | null
  wontFire: { bot: Bot; label: string; needsConnector: boolean } | null
  onRetired: () => void
}): { list: AutomationDetailNotice[]; ids: NoticeIds } {
  const t = useTranslate()
  const base = useId()
  const ids: NoticeIds = {
    running: `${base}-running`,
    offline: `${base}-offline`,
    checking: `${base}-checking`,
    oldHost: `${base}-oldhost`,
    foreign: `${base}-foreign`
  }
  const list: AutomationDetailNotice[] = []
  const { definition, continuity } = snapshot
  const automation = definition.value

  if (definition.status === 'deleted') {
    list.push({
      key: 'deleted',
      tone: 'amber',
      content: t('components.native-chat.automationSaved.deleted', 'This automation was deleted')
    })
  }
  if (continuity === 'retired' || continuity === 'unpaired') {
    list.push({
      key: 'retired',
      tone: 'amber',
      content: (
        <>
          <span className="min-w-0">
            {continuity === 'retired'
              ? t('bots.automationPanel.retired', "{{name}}'s computer changed.", {
                  name: bot.name
                })
              : t('bots.automationPanel.unpaired', "{{name}}'s computer isn't paired anymore.", {
                  name: bot.name
                })}
          </span>
          <Action label={t('bots.automationPanel.back', 'Back to Activity')} onPress={onRetired} />
        </>
      )
    })
  }
  if (continuity === 'checking') {
    list.push({
      key: 'checking',
      id: ids.checking,
      tone: 'amber',
      content: t('bots.automationPanel.checking', "Checking {{name}}'s computer…", {
        name: bot.name
      })
    })
  }
  if (offline) {
    list.push({
      key: 'offline',
      id: ids.offline,
      tone: 'amber',
      cause: 'host',
      content: t('bots.automationPanel.offline', '{{host}} is offline.', {
        host: offlineHostName
      })
    })
  }
  if (oldHost) {
    list.push({
      key: 'old-host',
      id: ids.oldHost,
      tone: 'amber',
      cause: 'host',
      content: t('bots.automationPanel.updateOrcaHistory', 'Update Orca on {{host}}.', {
        host: hostName
      })
    })
  }
  if (running) {
    list.push({
      key: 'running',
      id: ids.running,
      tone: 'info',
      content: (
        <>
          <span>{t('bots.automationPanel.runningNotice', 'Running')}</span>
          {runningAction ? (
            <Action label={runningAction.label} onPress={runningAction.onOpen} />
          ) : null}
        </>
      )
    })
  }
  if (automation?.bot && automation.bot.botId !== bot.id) {
    list.push({
      key: 'foreign',
      id: ids.foreign,
      tone: 'amber',
      content: t('bots.automationPanel.foreign', 'This automation now belongs to another bot.')
    })
  }
  if (wontFire) {
    list.push({
      key: 'wont-fire',
      tone: 'amber',
      content: <span className="min-w-0">{wontFire.label}</span>
    })
  }
  // A read problem the host's own notices don't already explain.
  if (
    definition.error &&
    !offline &&
    definition.error.kind !== 'unsupported' &&
    continuity === 'same'
  ) {
    list.push({
      key: 'definition-read',
      tone: automation ? 'info' : 'red',
      content: (
        <>
          <span className="min-w-0">
            {automation
              ? t('bots.automationPanel.settingsStale', "Couldn't read the latest settings.")
              : t(
                  'components.native-chat.automationSaved.loadFailed',
                  'Couldn’t read this automation'
                )}
          </span>
          <Action
            label={t('bots.automationPanel.retry', 'Retry')}
            onPress={() => controller.reload()}
          />
        </>
      )
    })
  }
  return { list, ids }
}
