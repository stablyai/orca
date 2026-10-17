import { ChevronDown } from 'lucide-react'
import { useState } from 'react'
import { normalizeProxyBypassRules, normalizeProxyUrl } from '../../../../shared/network-proxy'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { SettingsSwitch } from './SettingsFormControls'
import type { EditingTarget } from './ssh-target-draft'
import { translate } from '@/i18n/i18n'

// Why: mirror the composer's "Advanced" disclosure (ghost button + rotating chevron) so the
// add-host dialog reads the same, while reusing the exact field labels/help text from the
// Settings SSH form (proxy, jump host, connection reuse, terminal persistence).
export function SshHostAdvancedFields({
  open,
  onOpenChange,
  form,
  disabled,
  onFormChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  form: EditingTarget
  disabled: boolean
  onFormChange: (updater: (prev: EditingTarget) => EditingTarget) => void
}): React.JSX.Element {
  // Why mirror the local Advanced section: inline blur validation catches malformed
  // proxy URLs before save, with the same normalized-commit behavior for bypass rules.
  const [proxyUrlError, setProxyUrlError] = useState<string | null>(null)

  const validateProxyUrlDraft = (): void => {
    const normalized = normalizeProxyUrl(form.httpProxyUrl)
    setProxyUrlError(normalized.ok ? null : normalized.message)
  }

  const commitProxyBypassRules = (): void => {
    const normalized = normalizeProxyBypassRules(form.httpProxyBypassRules)
    if (normalized !== form.httpProxyBypassRules) {
      onFormChange((f) => ({ ...f, httpProxyBypassRules: normalized }))
    }
  }

  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className="col-span-2 sm:col-span-2">
      <CollapsibleTrigger asChild>
        {/* Why: no negative margin — the button's highlight would overhang and get clipped by the
            dialog/settings containers. A small left padding keeps it flush without overflow. */}
        <Button type="button" variant="ghost" size="sm" className="px-2 text-xs">
          {translate('auto.components.sidebar.AddRemoteHostDialog.advanced', 'Advanced')}
          <ChevronDown className={cn('size-4 transition-transform', open && 'rotate-180')} />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="collapsible-height-content">
        <div className="space-y-4 pt-3">
          <div className="space-y-1.5">
            <Label htmlFor="add-ssh-proxy-command">
              {translate('auto.components.settings.SshTargetForm.c7d0e18ecb', 'Proxy Command')}
            </Label>
            <Input
              id="add-ssh-proxy-command"
              value={form.proxyCommand}
              disabled={disabled}
              onChange={(e) => onFormChange((f) => ({ ...f, proxyCommand: e.target.value }))}
              placeholder={translate(
                'auto.components.settings.SshTargetForm.f42d844544',
                'e.g. cloudflared access ssh --hostname %h'
              )}
            />
            <p className="text-[11px] text-muted-foreground">
              {translate(
                'auto.components.settings.SshTargetForm.3b01ca44a0',
                'Optional. Used for tunneling (e.g. Cloudflare Access, ProxyCommand).'
              )}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="add-ssh-jump-host">
              {translate('auto.components.settings.SshTargetForm.b2ab248ded', 'Jump Host')}
            </Label>
            <Input
              id="add-ssh-jump-host"
              value={form.jumpHost}
              disabled={disabled}
              onChange={(e) => onFormChange((f) => ({ ...f, jumpHost: e.target.value }))}
              placeholder={translate(
                'auto.components.settings.SshTargetForm.11bcb4507a',
                'bastion.example.com'
              )}
            />
            <p className="text-[11px] text-muted-foreground">
              {translate(
                'auto.components.settings.SshTargetForm.feae1d1e69',
                'Optional. Equivalent to ProxyJump / ssh -J.'
              )}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="add-ssh-http-proxy-url">
              {translate('auto.components.settings.SshTargetForm.httpProxyUrl', 'HTTP Proxy')}
            </Label>
            <Input
              id="add-ssh-http-proxy-url"
              variant="code"
              value={form.httpProxyUrl}
              disabled={disabled}
              onChange={(e) => {
                setProxyUrlError(null)
                onFormChange((f) => ({ ...f, httpProxyUrl: e.target.value }))
              }}
              onBlur={validateProxyUrlDraft}
              placeholder={translate(
                'auto.components.settings.SshTargetForm.httpProxyUrlPlaceholder',
                'http://proxy.example.com:8080'
              )}
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={proxyUrlError ? true : undefined}
            />
            {proxyUrlError ? (
              <p className="text-xs text-destructive">{proxyUrlError}</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.SshTargetForm.httpProxyUrlHelp',
                  'Applied as HTTP_PROXY/HTTPS_PROXY to terminals on this host. Must be reachable from the host itself, not this machine. Supports http, https, socks, socks4, and socks5 URLs.'
                )}
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="add-ssh-http-proxy-bypass">
              {translate(
                'auto.components.settings.SshTargetForm.httpProxyBypassRules',
                'Proxy Bypass Rules'
              )}
            </Label>
            <Textarea
              id="add-ssh-http-proxy-bypass"
              variant="code"
              value={form.httpProxyBypassRules}
              disabled={disabled}
              onChange={(e) =>
                onFormChange((f) => ({ ...f, httpProxyBypassRules: e.target.value }))
              }
              onBlur={commitProxyBypassRules}
              placeholder={translate(
                'auto.components.settings.SshTargetForm.httpProxyBypassRulesPlaceholder',
                'localhost, 127.0.0.1, *.internal'
              )}
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              rows={3}
            />
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.SshTargetForm.httpProxyBypassRulesHelp',
                'Optional. Separate hosts with commas, semicolons, or new lines.'
              )}
            </p>
          </div>
          <div className="flex items-start justify-between gap-4 py-1 text-xs">
            <div className="min-w-0 flex-1 space-y-0.5">
              <Label className="text-xs font-medium">
                {translate(
                  'auto.components.settings.SshTargetForm.8c922dffba',
                  'Reuse SSH connection for faster setup'
                )}
              </Label>
              <p className="text-muted-foreground">
                {translate(
                  'auto.components.settings.SshTargetForm.53e9aabfc0',
                  'Uses OpenSSH multiplexing when available. Turn off for hosts with custom SSH restrictions.'
                )}
              </p>
            </div>
            <SettingsSwitch
              checked={form.systemSshConnectionReuse}
              disabled={disabled}
              onChange={() =>
                onFormChange((f) => ({
                  ...f,
                  systemSshConnectionReuse: !f.systemSshConnectionReuse
                }))
              }
              ariaLabel={translate(
                'auto.components.settings.SshTargetForm.8c922dffba',
                'Reuse SSH connection for faster setup'
              )}
            />
          </div>
          <div className="flex items-start justify-between gap-4 py-1 text-xs">
            <div className="min-w-0 flex-1 space-y-0.5">
              <Label className="text-xs font-medium">
                {translate(
                  'auto.components.settings.SshTargetForm.allowRemoteCliControl',
                  "Allow this host's orca CLI to control Orca"
                )}
              </Label>
              <p className="text-muted-foreground">
                {translate(
                  'auto.components.settings.SshTargetForm.allowRemoteCliControlHelp',
                  "On by default for new hosts. Lets orca commands run on this host open and drive Orca browser tabs on this desktop, only in this host's workspaces and only while it is connected, and lets terminals started by an older Orca on this host run orchestration commands (check, inbox, send, ask, reply) for their own supervised work. They cannot read your files, clipboard or cookies. When off, they reach only this host's own Orca server."
                )}
              </p>
            </div>
            <SettingsSwitch
              checked={form.allowRemoteCliControl}
              disabled={disabled}
              onChange={() =>
                onFormChange((f) => ({
                  ...f,
                  allowRemoteCliControl: !f.allowRemoteCliControl
                }))
              }
              ariaLabel={translate(
                'auto.components.settings.SshTargetForm.allowRemoteCliControl',
                "Allow this host's orca CLI to control Orca"
              )}
            />
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
