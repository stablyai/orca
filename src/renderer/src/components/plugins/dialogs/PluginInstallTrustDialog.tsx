import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useIntlLocale, useTranslate, type Translate } from '@/i18n/use-translate'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import { usePluginInstallCountsStore } from '@/store/plugins/installation/plugin-install-counts'
import {
  settlePluginInstallTrust,
  usePluginInstallTrustStore
} from '@/store/plugins/installation/plugin-install-trust-request'
import { Button } from '../../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../ui/dialog'
import { formatPluginInstallCount } from '../presentation/plugin-install-count'
import type { PluginInstallTrustPrompt } from '../presentation/plugin-install-trust'
import { formatPluginReleaseDate } from '../presentation/plugin-release-date'

function trustTitle(prompt: PluginInstallTrustPrompt, t: Translate = translate): string {
  if (prompt.kind === 'local-folder' || prompt.kind === 'dev-folder') {
    return t(
      'auto.components.settings.PluginInstallTrustDialog.titleFolder',
      'Make sure you trust this folder'
    )
  }
  return t(
    'auto.components.settings.PluginInstallTrustDialog.title',
    'Make sure you trust {{value0}}',
    { value0: prompt.trustee }
  )
}

function trustBody(prompt: PluginInstallTrustPrompt, t: Translate = translate): string {
  const value0 = prompt.trustee
  switch (prompt.kind) {
    case 'theme':
      return t(
        'auto.components.settings.PluginInstallTrustDialog.theme',
        'This theme is from {{value0}}, not Orca. Only install plugins from authors you trust.',
        { value0 }
      )
    case 'content':
      return t(
        'auto.components.settings.PluginInstallTrustDialog.content',
        'This plugin is from {{value0}}, not Orca. Only install plugins from authors you trust.',
        { value0 }
      )
    case 'translations':
      return t(
        'auto.components.settings.PluginInstallTrustDialog.translations',
        'This translation is from {{value0}}, not Orca. Translations can change any text in Orca, so only install them from authors you trust.',
        { value0 }
      )
    case 'code':
      return t(
        'auto.components.settings.PluginInstallTrustDialog.code',
        'This plugin is from {{value0}}, not Orca. It runs the publisher’s code inside Orca, so only install it if you trust {{value0}}.',
        { value0 }
      )
    case 'git':
      return t(
        'auto.components.settings.PluginInstallTrustDialog.git',
        'Orca hasn’t checked this repository. A plugin from it can run its publisher’s code inside Orca, so only install it if you trust {{value0}}.',
        { value0 }
      )
    case 'local-folder':
      return t(
        'auto.components.settings.PluginInstallTrustDialog.localFolder',
        'This is an unverified local folder. A plugin from it can run code inside Orca, so only install it if you trust where it came from.'
      )
    case 'dev-folder':
      return t(
        'auto.components.settings.PluginInstallTrustDialog.devFolder',
        'This is an unverified local folder. Orca loads its plugin as it is, and later code edits run without asking, so only add folders you trust.'
      )
  }
}

function TrustDetail({
  label,
  value,
  href,
  mono = false
}: {
  label: string
  value: string
  href?: string | null
  mono?: boolean
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-baseline gap-x-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd data-mono={mono} className="min-w-0 break-all text-xs data-[mono=true]:font-mono">
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 underline-offset-4 hover:underline"
            onClick={(event) => {
              event.preventDefault()
              openAppHttpLink(href, { destination: 'system', event })
            }}
          >
            <span>{value}</span>
            <ArrowUpRight className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
          </a>
        ) : (
          value
        )}
      </dd>
    </div>
  )
}

/**
 * "Make sure you trust …" before any non-official plugin installs. Cancel holds focus, so a held
 * Enter or a link-opened page can never install without a deliberate click on Install.
 */
export function PluginInstallTrustDialog({
  prompt,
  onCancel,
  onConfirm
}: {
  prompt: PluginInstallTrustPrompt | null
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const cancelRef = useRef<HTMLButtonElement>(null)
  // Why keep the last prompt: the closing animation must not flash an empty dialog.
  const [shown, setShown] = useState(prompt)
  if (prompt && prompt !== shown) {
    setShown(prompt)
  }
  const current = prompt ?? shown
  const installCountKey = current?.installCountPluginKey ?? null
  const installCount = usePluginInstallCountsStore((state) =>
    installCountKey ? state.counts[installCountKey] : undefined
  )
  const updated = formatPluginReleaseDate(current?.updatedAt ?? undefined, intlLocale)
  const installs =
    typeof installCount === 'number' ? formatPluginInstallCount(installCount, intlLocale) : null
  const pageUrl = current?.pluginPageUrl ?? null
  const folder = current?.kind === 'local-folder' || current?.kind === 'dev-folder'
  return (
    <Dialog open={prompt !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent
        surface="security"
        className="z-[120]"
        overlayClassName="z-[115]"
        data-plugin-install-trust={current?.kind}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          cancelRef.current?.focus()
        }}
      >
        {current ? (
          <>
            <DialogHeader>
              <DialogTitle className="break-words">{trustTitle(current, t)}</DialogTitle>
              <DialogDescription>{trustBody(current, t)}</DialogDescription>
            </DialogHeader>
            {current.access.length > 0 ? (
              <ul className="list-disc space-y-1 pl-5 text-sm text-foreground">
                {current.access.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            ) : null}
            <dl className="space-y-1.5 rounded-md border border-border px-3 py-2.5">
              {current.publisher ? (
                <TrustDetail
                  label={t(
                    'auto.components.settings.PluginInstallTrustDialog.publisher',
                    'Publisher'
                  )}
                  value={current.publisher}
                  mono
                />
              ) : null}
              {current.version ? (
                <TrustDetail
                  label={t('auto.components.settings.PluginInstallTrustDialog.version', 'Version')}
                  value={current.version}
                />
              ) : null}
              {updated ? (
                <TrustDetail
                  label={t('auto.components.settings.PluginInstallTrustDialog.updated', 'Updated')}
                  value={updated}
                />
              ) : null}
              {installs ? (
                <TrustDetail
                  label={t(
                    'auto.components.settings.PluginInstallTrustDialog.installs',
                    'Installs'
                  )}
                  value={installs}
                />
              ) : null}
              {current.repository ? (
                <TrustDetail
                  label={t(
                    'auto.components.settings.PluginInstallTrustDialog.repository',
                    'Repository'
                  )}
                  value={current.repository}
                  href={current.repositoryUrl}
                  mono
                />
              ) : null}
              {current.location ? (
                <TrustDetail
                  label={
                    folder
                      ? t('auto.components.settings.PluginInstallTrustDialog.folder', 'Folder')
                      : t('auto.components.settings.PluginInstallTrustDialog.catalog', 'Catalog')
                  }
                  value={current.location}
                  mono={folder}
                />
              ) : null}
            </dl>
          </>
        ) : null}
        <DialogFooter className={pageUrl ? 'sm:items-center sm:justify-between' : undefined}>
          {pageUrl ? (
            <Button
              variant="link-muted"
              size="inline"
              onClick={(event) => openAppHttpLink(pageUrl, { destination: 'system', event })}
            >
              {t(
                'auto.components.settings.PluginInstallTrustDialog.pluginPage',
                'View plugin page'
              )}
              <ArrowUpRight />
            </Button>
          ) : null}
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button ref={cancelRef} variant="ghost" onClick={onCancel}>
              {t('auto.components.settings.PluginInstallTrustDialog.cancel', 'Cancel')}
            </Button>
            <Button onClick={onConfirm}>
              {current?.kind === 'dev-folder'
                ? t('auto.components.settings.PluginInstallTrustDialog.addFolder', 'Add folder')
                : t('auto.components.settings.PluginInstallTrustDialog.install', 'Install')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Shows the install waiting for review, including language packs during onboarding. */
export function PluginInstallTrustDialogHost(): React.JSX.Element {
  const pending = usePluginInstallTrustStore((state) => state.pending)
  useEffect(() => () => settlePluginInstallTrust(false), [])
  return (
    <PluginInstallTrustDialog
      prompt={pending?.prompt ?? null}
      onCancel={() => settlePluginInstallTrust(false)}
      onConfirm={() => settlePluginInstallTrust(true)}
    />
  )
}
