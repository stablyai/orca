import { ChevronDown, Share2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { RuntimePairingUrlGenerator } from './RuntimePairingUrlGenerator'

export type RemoteServerWorkflow = 'connect' | 'cloud-vm' | 'share'

export function RuntimeServerWorkflowPicker({
  canGeneratePairingUrl,
  visibleWorkflow,
  onCloseAddServerForm,
  onWorkflowChange
}: {
  canGeneratePairingUrl: boolean
  visibleWorkflow: RemoteServerWorkflow
  onCloseAddServerForm: () => void
  onWorkflowChange: (workflow: RemoteServerWorkflow) => void
}): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label={translate(
        'auto.components.settings.RuntimeEnvironmentsPane.workflow',
        'Remote server workflow'
      )}
      className={cn('grid gap-2 sm:grid-cols-2', canGeneratePairingUrl && 'sm:grid-cols-3')}
    >
      {(
        [
          [
            'connect',
            translate(
              'auto.components.settings.RuntimeEnvironmentsPane.connectWorkflow',
              'Connect to a host'
            ),
            translate(
              'auto.components.settings.RuntimeEnvironmentsPane.connectWorkflowHelp',
              'This app joins another machine'
            )
          ],
          [
            'share',
            translate(
              'auto.components.settings.RuntimeEnvironmentsPane.shareWorkflow',
              'Share this host'
            ),
            translate(
              'auto.components.settings.RuntimeEnvironmentsPane.shareWorkflowHelp',
              'Other devices join this machine'
            )
          ],
          [
            'cloud-vm',
            translate(
              'auto.components.settings.RuntimeEnvironmentsPane.cloudVmWorkflow',
              'Cloud VM'
            ),
            translate(
              'auto.components.settings.RuntimeEnvironmentsPane.cloudVmWorkflowHelp',
              'Manage recipe-created cloud machines'
            )
          ]
        ] as const
      )
        .filter(([value]) => value !== 'share' || canGeneratePairingUrl)
        .map(([value, label, description]) => (
          <button
            key={value}
            type="button"
            aria-pressed={visibleWorkflow === value}
            onClick={() => {
              if (value !== 'connect') {
                onCloseAddServerForm()
              }
              onWorkflowChange(value)
            }}
            className={cn(
              'rounded-lg border p-3 text-left transition-colors',
              visibleWorkflow === value
                ? 'border-ring bg-accent text-accent-foreground'
                : 'border-border hover:bg-accent'
            )}
          >
            <span className="block text-sm font-medium">{label}</span>
            <span
              className={cn(
                'mt-1 block text-xs',
                visibleWorkflow === value ? 'text-accent-foreground' : 'text-muted-foreground'
              )}
            >
              {description}
            </span>
          </button>
        ))}
    </div>
  )
}

export function RuntimeServerShareSection({
  shareServerFormOpen,
  onToggleShareServerForm
}: {
  shareServerFormOpen: boolean
  onToggleShareServerForm: () => void
}): React.JSX.Element {
  return (
    <div className="space-y-3 pt-2">
      <div className="space-y-0.5">
        <div className="text-sm font-medium">
          {translate(
            'auto.components.settings.RuntimeEnvironmentsPane.advertiseThisApp',
            'Advertise this app as a server'
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.RuntimeEnvironmentsPane.advertiseThisAppHelp',
            'Create access links for browsers, mobile clients, or another Orca client to connect back to this running app.'
          )}
        </p>
      </div>
      <div className="overflow-hidden rounded-lg border border-border/50 bg-card/30">
        <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium">
              {translate(
                'auto.components.settings.RuntimeEnvironmentsPane.6e1280ca55',
                'Share this Orca server'
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.RuntimeEnvironmentsPane.84b9b2be05',
                'Create a revocable access grant so a browser or another Orca client can connect.'
              )}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={onToggleShareServerForm}
          >
            <Share2 />
            {shareServerFormOpen
              ? translate(
                  'auto.components.settings.RuntimeEnvironmentsPane.54dee18f5c',
                  'Hide Form'
                )
              : translate(
                  'auto.components.settings.RuntimeEnvironmentsPane.3595fd1948',
                  'New Link'
                )}
          </Button>
        </div>
        <div className="border-t border-border/40 px-3 py-3">
          <RuntimePairingUrlGenerator
            framed={false}
            showHeader={false}
            showGeneratorForm={shareServerFormOpen}
          />
        </div>
      </div>
    </div>
  )
}

export function RuntimeServerTroubleshooting(): React.JSX.Element {
  return (
    <details className="group rounded-lg border border-border/60">
      <summary className="flex cursor-pointer list-none items-center gap-2 p-4 text-sm font-medium">
        {translate(
          'auto.components.settings.RuntimeEnvironmentsPane.troubleshootWorkflow',
          'Connection troubleshooting'
        )}
        <ChevronDown className="ml-auto size-4 transition-transform group-open:rotate-180" />
      </summary>
      <div className="space-y-4 border-t border-border/50 p-4">
        <div className="space-y-1">
          <div className="text-sm font-medium">
            {translate(
              'auto.components.settings.RuntimeEnvironmentsPane.troubleshootTitle',
              'Create a new link on the other host'
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.RuntimeEnvironmentsPane.troubleshootDescription',
              'A link that uses 127.0.0.1 points back to the device opening it, not the computer that created it.'
            )}
          </p>
        </div>
        <ol className="ml-4 list-decimal space-y-1 text-xs text-muted-foreground">
          <li>
            {translate(
              'auto.components.settings.RuntimeEnvironmentsPane.troubleshootStepShare',
              'On the other computer, open Share this host.'
            )}
          </li>
          <li>
            {translate(
              'auto.components.settings.RuntimeEnvironmentsPane.troubleshootStepAddress',
              'Choose Another device and select its Tailscale or LAN address.'
            )}
          </li>
          <li>
            {translate(
              'auto.components.settings.RuntimeEnvironmentsPane.troubleshootStepRegenerate',
              'Generate a new access link and use only the newest link here.'
            )}
          </li>
        </ol>
        <div className="rounded-md border border-border/60 bg-muted/30 p-3 text-xs">
          {translate(
            'auto.components.settings.RuntimeEnvironmentsPane.troubleshootTunnel',
            'Using an SSH local forward? Return to Connect to a host, paste the loopback link, then enable “I am using an SSH tunnel” under Advanced.'
          )}
        </div>
      </div>
    </details>
  )
}
