import type React from 'react'
import { Check, Copy, Loader2 } from 'lucide-react'
import { Trans } from 'react-i18next'
import type { OrcaUninstallPlan } from '../../../../../../shared/uninstall/orca-uninstall-types'
import { useClipboardTextCopyFeedback } from '@/hooks/clipboard/use-clipboard-text-copy-feedback'
import { getShowInFileManagerLabel } from '@/lib/files/os-open/local-file-manager-label'
import { cn } from '@/lib/class-names'
import { i18n } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '../../../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../ui/tooltip'
import type { OrcaUninstallModel } from './use-orca-uninstall'

const HINT_CLASS = 'text-settings-detail text-muted-foreground'

function CommandBox({ command }: { command: string }): React.JSX.Element {
  const t = useTranslate()
  const { copyText, status } = useClipboardTextCopyFeedback(command)
  const label = t('settings.uninstall.copyCommand', 'Copy command')
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/40 py-1.5 pr-1.5 pl-3">
      <code className="min-w-0 break-all font-mono text-xs">{command}</code>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-xs" aria-label={label} onClick={() => void copyText()}>
            {status === 'copied' ? <Check /> : <Copy />}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {label}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

function NextStep({
  plan,
  finish
}: {
  plan: OrcaUninstallPlan
  finish: OrcaUninstallModel['finish']
}): React.JSX.Element {
  const t = useTranslate()
  const quit = (
    <Button size="sm" onClick={() => finish('quit')}>
      {t('settings.uninstall.quit', 'Quit Orca')}
    </Button>
  )
  const reveal = (platform: string): React.ReactNode =>
    plan.appPath ? (
      <Button variant="outline" size="sm" onClick={() => finish('reveal-app')}>
        {getShowInFileManagerLabel(platform, t)}
      </Button>
    ) : null

  let lead: React.ReactNode = t(
    'settings.uninstall.next.unknown',
    'Quit Orca, then delete the app.'
  )
  let actions: React.ReactNode = quit
  let command: string | null = null
  switch (plan.installKind) {
    case 'mac-app':
      lead = t(
        'settings.uninstall.next.macApp',
        'Quit Orca, then drag it from Applications to the Trash.'
      )
      actions = (
        <>
          {reveal('darwin')}
          {quit}
        </>
      )
      break
    case 'mac-homebrew':
      if (plan.removeAppCommand) {
        lead = t(
          'settings.uninstall.next.homebrew',
          'Orca was installed with Homebrew. Run this to remove the app:'
        )
        command = plan.removeAppCommand
      }
      break
    case 'linux-package':
      if (plan.removeAppCommand) {
        lead = t('settings.uninstall.next.linuxPackage', 'Run this to remove the package:')
        command = plan.removeAppCommand
      }
      break
    case 'windows-installer':
      lead = t(
        'settings.uninstall.next.windows',
        'Finish in the Windows uninstaller. Orca quits when it opens.'
      )
      actions = (
        <Button size="sm" onClick={() => finish('open-windows-uninstaller')}>
          {t('settings.uninstall.openUninstaller', 'Open uninstaller')}
        </Button>
      )
      break
    case 'linux-appimage':
      if (plan.appPath) {
        lead = (
          <Trans
            i18n={i18n}
            defaults={t(
              'settings.uninstall.next.appImage',
              'Quit Orca, then delete <path>{{path}}</path>.'
            )}
            values={{ path: plan.appPath }}
            components={{ path: <span className="break-all font-mono text-xs" /> }}
          />
        )
        actions = (
          <>
            {reveal('linux')}
            {quit}
          </>
        )
      }
      break
    case 'unknown':
      break
  }

  return (
    <div className="flex flex-col gap-2 pt-3 pb-3.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 text-[13px]">{lead}</div>
        <div className="flex shrink-0 gap-2">{actions}</div>
      </div>
      {command ? <CommandBox command={command} /> : null}
      <p className={HINT_CLASS}>
        {t(
          'settings.uninstall.agentStatusOff',
          "Agent status is off. Orca won't add hooks again unless you turn it on in Settings → Agents."
        )}
      </p>
    </div>
  )
}

/** Before the run: what stays and the Uninstall button. After: how to delete the app on this machine. */
export function OrcaUninstallFooter({
  model
}: {
  model: Pick<OrcaUninstallModel, 'plan' | 'loadFailed' | 'phase' | 'start' | 'reload' | 'finish'>
}): React.JSX.Element {
  const t = useTranslate()
  const { plan, phase } = model
  if (phase === 'done' && plan) {
    return <NextStep plan={plan} finish={model.finish} />
  }
  if (model.loadFailed) {
    return (
      <div className="flex items-center justify-between gap-3 pt-3 pb-3.5">
        <p className={HINT_CLASS}>
          {t('settings.uninstall.loadFailed', 'Orca could not check what it installed.')}
        </p>
        <Button variant="outline" size="sm" onClick={model.reload}>
          {t('settings.uninstall.tryAgain', 'Try again')}
        </Button>
      </div>
    )
  }
  const running = phase === 'running'
  let hint = t('settings.uninstall.keeps', 'Projects, worktrees and Orca settings stay.')
  if (plan?.terminalDaemon) {
    hint = `${hint} ${t('settings.uninstall.closesTerminals', 'Open terminals will close.')}`
  }
  if (plan?.otherOrcaBuildName) {
    hint = `${hint} ${t(
      'settings.uninstall.keepsShared',
      '{{name}} is also installed, so hooks it shares stay too.',
      { name: plan.otherOrcaBuildName }
    )}`
  }
  return (
    <div className="flex items-center justify-between gap-3 pt-3 pb-3.5">
      <p className={`${HINT_CLASS} min-w-0 flex-1`}>
        {running ? t('settings.uninstall.removing', 'Removing…') : hint}
      </p>
      <Button
        variant="destructive"
        size="sm"
        disabled={!plan || running}
        onClick={model.start}
        className="shrink-0"
      >
        {/* Both labels share one cell so the button keeps its width when they swap. */}
        <span className="grid">
          <span
            aria-hidden={running}
            className={cn('col-start-1 row-start-1 text-center', running && 'invisible')}
          >
            {t('settings.uninstall.button', 'Uninstall')}
          </span>
          <span
            aria-hidden={!running}
            className={cn(
              'col-start-1 row-start-1 flex items-center justify-center gap-1.5',
              !running && 'invisible'
            )}
          >
            <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
            {t('settings.uninstall.uninstalling', 'Uninstalling…')}
          </span>
        </span>
      </Button>
    </div>
  )
}
