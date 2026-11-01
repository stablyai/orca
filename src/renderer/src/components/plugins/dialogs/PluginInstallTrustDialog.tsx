import { useEffect, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import {
  settlePluginInstallTrust,
  usePluginInstallTrustStore
} from '@/store/plugin-install-trust-request'
import { Button } from '../../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../ui/dialog'
import type { PluginInstallTrustPrompt } from '../presentation/plugin-install-trust'

function trustTitle(prompt: PluginInstallTrustPrompt): string {
  if (prompt.kind === 'local-folder' || prompt.kind === 'dev-folder') {
    return translate(
      'auto.components.settings.PluginInstallTrustDialog.titleFolder',
      'Make sure you trust this folder'
    )
  }
  return translate(
    'auto.components.settings.PluginInstallTrustDialog.title',
    'Make sure you trust {{value0}}',
    { value0: prompt.trustee }
  )
}

function trustBody(prompt: PluginInstallTrustPrompt): string {
  const value0 = prompt.trustee
  switch (prompt.kind) {
    case 'theme':
      return translate(
        'auto.components.settings.PluginInstallTrustDialog.theme',
        'This theme is from {{value0}}, not Orca. Only install plugins from authors you trust.',
        { value0 }
      )
    case 'content':
      return translate(
        'auto.components.settings.PluginInstallTrustDialog.content',
        'This plugin is from {{value0}}, not Orca. Only install plugins from authors you trust.',
        { value0 }
      )
    case 'translations':
      return translate(
        'auto.components.settings.PluginInstallTrustDialog.translations',
        'This translation is from {{value0}}, not Orca. Translations can change any text in Orca, so only install them from authors you trust.',
        { value0 }
      )
    case 'code':
      return translate(
        'auto.components.settings.PluginInstallTrustDialog.code',
        'This plugin is from {{value0}}, not Orca. It runs the publisher’s code inside Orca, so only install it if you trust {{value0}}.',
        { value0 }
      )
    case 'git':
      return translate(
        'auto.components.settings.PluginInstallTrustDialog.git',
        'Orca hasn’t checked this repository. A plugin from it can run its publisher’s code inside Orca, so only install it if you trust {{value0}}.',
        { value0 }
      )
    case 'local-folder':
      return translate(
        'auto.components.settings.PluginInstallTrustDialog.localFolder',
        'This is an unverified local folder. A plugin from it can run code inside Orca, so only install it if you trust where it came from.'
      )
    case 'dev-folder':
      return translate(
        'auto.components.settings.PluginInstallTrustDialog.devFolder',
        'This is an unverified local folder. Orca loads its plugin as it is, and later code edits run without asking, so only add folders you trust.'
      )
  }
}

function TrustDetail({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-baseline gap-x-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-all font-mono text-xs">{value}</dd>
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
  const cancelRef = useRef<HTMLButtonElement>(null)
  // Why keep the last prompt: the closing animation must not flash an empty dialog.
  const [shown, setShown] = useState(prompt)
  if (prompt && prompt !== shown) {
    setShown(prompt)
  }
  const current = prompt ?? shown
  const folder = current?.kind === 'local-folder' || current?.kind === 'dev-folder'
  return (
    <Dialog open={prompt !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent
        surface="security"
        data-plugin-install-trust={current?.kind}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          cancelRef.current?.focus()
        }}
      >
        {current ? (
          <>
            <DialogHeader>
              <DialogTitle className="break-words">{trustTitle(current)}</DialogTitle>
              <DialogDescription>{trustBody(current)}</DialogDescription>
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
                  label={translate(
                    'auto.components.settings.PluginInstallTrustDialog.publisher',
                    'Publisher'
                  )}
                  value={current.publisher}
                />
              ) : null}
              {current.repository ? (
                <TrustDetail
                  label={translate(
                    'auto.components.settings.PluginInstallTrustDialog.repository',
                    'Repository'
                  )}
                  value={current.repository}
                />
              ) : null}
              {current.location ? (
                <TrustDetail
                  label={
                    folder
                      ? translate(
                          'auto.components.settings.PluginInstallTrustDialog.folder',
                          'Folder'
                        )
                      : translate(
                          'auto.components.settings.PluginInstallTrustDialog.catalog',
                          'Catalog'
                        )
                  }
                  value={current.location}
                />
              ) : null}
            </dl>
          </>
        ) : null}
        <DialogFooter>
          <Button ref={cancelRef} variant="ghost" onClick={onCancel}>
            {translate('auto.components.settings.PluginInstallTrustDialog.cancel', 'Cancel')}
          </Button>
          <Button onClick={onConfirm}>
            {current?.kind === 'dev-folder'
              ? translate(
                  'auto.components.settings.PluginInstallTrustDialog.addFolder',
                  'Add folder'
                )
              : translate('auto.components.settings.PluginInstallTrustDialog.install', 'Install')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Shows whichever install is waiting; leaving the pane declines it so nothing installs unseen. */
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
