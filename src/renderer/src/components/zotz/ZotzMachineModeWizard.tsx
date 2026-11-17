import { Laptop, Server } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { Button } from '../ui/button'
import { ZotzServerSetupPanel } from './ZotzServerSetupPanel'

function ModeOption({
  icon,
  title,
  description,
  onSelect
}: {
  icon: React.ReactNode
  title: string
  description: string
  onSelect: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-start gap-4 rounded-xl border border-border bg-card/50 p-4 text-left shadow-xs transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <span className="mt-0.5 shrink-0 text-muted-foreground">{icon}</span>
      <span className="min-w-0 space-y-1">
        <span className="block text-sm font-semibold">{title}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
    </button>
  )
}

/** First-run choice between a personal computer and an always-on remote server. */
export default function ZotzMachineModeWizard({
  onClose,
  onKeepOpen
}: {
  onClose: () => void
  /** Choosing server flips the mode off `unset`; the wizard must stay up while it runs. */
  onKeepOpen: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const previousMode = useAppStore((state) => state.settings?.zotzMachineMode ?? 'unset')
  const updateSettings = useAppStore((state) => state.updateSettingsOrThrow)
  const [page, setPage] = useState<'choose' | 'server'>('choose')

  const choosePersonal = async (): Promise<void> => {
    try {
      await updateSettings({ zotzMachineMode: 'personal' })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
      return
    }
    onClose()
    if (previousMode === 'personal') {
      return
    }
    // A partial server setup can register the sign-in task without ever saving server mode.
    try {
      const removal = await window.api.zotzNode.removeAutostart()
      if (removal.ok && removal.removed) {
        toast.success(t('zotz.machineMode.autostartRemoved', 'Zotz no longer starts at sign-in.'))
      } else if (!removal.ok) {
        toast.error(
          t(
            'zotz.machineMode.autostartRemoveFailed',
            'Could not remove the sign-in task: {{detail}}',
            {
              detail: removal.detail
            }
          )
        )
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
    if (previousMode === 'server') {
      toast.info(
        t(
          'zotz.machineMode.pairedDevicesKeepAccess',
          'Paired computers and phones can still connect until you revoke them in Settings → Remote Orca Servers.'
        )
      )
    }
  }

  return (
    <div className="flex h-full w-full items-start justify-center overflow-y-auto px-8 py-16 scrollbar-sleek">
      <div className="w-full max-w-xl">
        {page === 'server' ? (
          <ZotzServerSetupPanel
            onBack={() => setPage('choose')}
            onStart={onKeepOpen}
            onDone={onClose}
          />
        ) : (
          <div className="space-y-6">
            <div className="space-y-2">
              <h1 className="text-xl font-semibold">
                {t('zotz.machineMode.title', 'How will you use this computer?')}
              </h1>
              <p className="text-sm text-muted-foreground">
                {t(
                  'zotz.machineMode.description',
                  'You can change this later in Settings → General.'
                )}
              </p>
            </div>
            <div className="space-y-3">
              <ModeOption
                icon={<Laptop className="size-5" />}
                title={t('zotz.machineMode.personal.title', 'Personal')}
                description={t(
                  'zotz.machineMode.personal.description',
                  'Use Zotz on this computer. Nothing in the system changes.'
                )}
                onSelect={() => void choosePersonal()}
              />
              <ModeOption
                icon={<Server className="size-5" />}
                title={t('zotz.machineMode.server.title', 'Remote server')}
                description={t(
                  'zotz.machineMode.server.description',
                  'An always-on node: reachable over Tailscale, never sleeps, starts by itself. You send it work from another computer or your phone.'
                )}
                onSelect={() => setPage('server')}
              />
            </div>
            <div className="flex justify-end">
              <Button type="button" variant="ghost" onClick={onClose}>
                {t('zotz.machineMode.later', 'Decide later')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
