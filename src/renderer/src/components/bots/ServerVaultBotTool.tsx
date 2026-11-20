import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { botTarget, type BotRef } from '@/lib/bot-hosts'
import type {
  BotToolVaultDestination,
  ServerVaultTarget,
  VaultEntry
} from '../../../../shared/secure-storage/credential-vault'
import { changed } from './bot-tools-revision'

type Tool = BotToolVaultDestination & ({ version: string; linked: boolean } | { create: true })

type ToolControlProps = {
  tool: Tool
  disabled?: boolean
  onSavingChange?: (saving: boolean) => void
  onChanged: () => void
}

export function ServerVaultBotTool({
  bot,
  ...control
}: ToolControlProps & { bot: BotRef }): React.JSX.Element | null {
  const target = botTarget(bot)
  const environment = useAppStore((state) =>
    target.kind === 'environment'
      ? state.runtimeEnvironments.find((entry) => entry.id === target.environmentId)
      : undefined
  )
  if (!environment || !window.api.credentialVault) {
    return null
  }
  const revision = environment.pairingRevision ?? environment.createdAt
  return (
    <ServerVaultBotToolControl
      key={`${environment.id}:${revision}`}
      {...control}
      target={{ environmentId: environment.id, pairingRevision: revision }}
    />
  )
}

function ServerVaultBotToolControl({
  target,
  tool,
  disabled,
  onSavingChange,
  onChanged
}: ToolControlProps & { target: ServerVaultTarget }): React.JSX.Element {
  const t = useTranslate()
  const creating = 'create' in tool
  const linked = !creating && tool.linked
  const [entries, setEntries] = useState<VaultEntry[] | null>(null)
  const [id, setId] = useState('')
  const [scheme, setScheme] = useState<'bearer' | 'api-key'>('bearer')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [restricted, setRestricted] = useState(false)
  const api = window.api.credentialVault
  const load = async (): Promise<void> => {
    setEntries(null)
    setId('')
    setError(false)
    setRestricted(false)
    if (linked) {
      return
    }
    try {
      const result = await api.list(target)
      if (result.ok) {
        setEntries(result.value.filter((entry) => entry.kind === 'secret'))
      } else {
        setRestricted(result.reason === 'forbidden')
        setError(true)
      }
    } catch {
      setError(true)
    }
  }
  const apply = async (): Promise<void> => {
    if (busy || disabled) {
      return
    }
    setBusy(true)
    onSavingChange?.(true)
    setError(false)
    setRestricted(false)
    try {
      const { botId, name, url } = tool
      const binding = { id, scheme }
      const result = await api.changeBotTool(
        creating
          ? { botId, name, url, create: true, binding }
          : { botId, name, url, version: tool.version, binding: linked ? undefined : binding },
        target
      )
      if (result.ok) {
        changed()
        onChanged()
      } else {
        setRestricted(result.reason === 'forbidden')
        setError(true)
      }
    } catch {
      setError(true)
    }
    setBusy(false)
    onSavingChange?.(false)
  }
  return (
    <Popover
      onOpenChange={(open) => {
        if (open) {
          void load()
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant={creating ? 'secondary' : 'outline'}
          size="sm"
          className={creating ? undefined : 'justify-self-start'}
          disabled={disabled}
        >
          {linked
            ? t('settings.credentialVault.botLinked', 'Vault credential linked')
            : t('settings.credentialVault.botUseVault', 'Use server vault')}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align={creating ? 'end' : 'start'}
        sideOffset={8}
        collisionPadding={12}
        wheelScroll
        className="flex w-80 max-w-(--radix-popover-content-available-width) flex-col"
      >
        <div className="grid min-h-0 grid-cols-1 gap-3 overflow-y-auto overscroll-contain p-4 scrollbar-sleek">
          <p className="text-sm text-muted-foreground">
            {linked
              ? t(
                  'settings.credentialVault.botUnlinkHint',
                  'Unlinking stops this tool from receiving the vault credential.'
                )
              : t(
                  'settings.credentialVault.botLinkHint',
                  'Orca sends the selected key only to this tool’s saved HTTPS URL. The bot does not receive the key itself.'
                )}
          </p>
          <p className="break-all font-mono text-xs text-muted-foreground">{tool.url}</p>
          {!linked && !error && entries === null ? (
            <p role="status" className="text-sm text-muted-foreground">
              {t('settings.credentialVault.loading', 'Loading vault…')}
            </p>
          ) : null}
          {!linked && entries?.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t(
                'settings.credentialVault.botNoKeys',
                'Add an API key or token to this server’s vault first.'
              )}
            </p>
          ) : null}
          {!linked && entries && entries.length > 0 ? (
            <>
              <div className="space-y-2">
                <Label>{t('settings.credentialVault.botKey', 'Vault entry')}</Label>
                <Select value={id} onValueChange={setId} disabled={busy}>
                  <SelectTrigger
                    className="w-full *:data-[slot=select-value]:min-w-0"
                    aria-label={t('settings.credentialVault.botKey', 'Vault entry')}
                  >
                    <SelectValue
                      placeholder={t('settings.credentialVault.botChooseKey', 'Choose a key')}
                    >
                      <span className="min-w-0 truncate">
                        {entries.find((entry) => entry.id === id)?.name}
                      </span>
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent position="popper" className="w-(--radix-select-trigger-width)">
                    {entries.map((entry) => (
                      <SelectItem key={entry.id} value={entry.id}>
                        <span className="min-w-0 wrap-anywhere">{entry.name}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>{t('settings.credentialVault.botHeader', 'Authentication header')}</Label>
                <Select
                  value={scheme}
                  onValueChange={(value) => setScheme(value === 'api-key' ? 'api-key' : 'bearer')}
                  disabled={busy}
                >
                  <SelectTrigger
                    className="w-full"
                    aria-label={t('settings.credentialVault.botHeader', 'Authentication header')}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper" className="w-(--radix-select-trigger-width)">
                    <SelectItem value="bearer">
                      {t('settings.credentialVault.botHeaderBearer', 'Authorization: Bearer')}
                    </SelectItem>
                    <SelectItem value="api-key">
                      {t('settings.credentialVault.botHeaderApiKey', 'X-API-Key')}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {restricted
                ? t(
                    'settings.credentialVault.serverAccessRequired',
                    'Access is not enabled for this pairing. Create a new link on the server with orca pair --grant-credential-vault, then pair again.'
                  )
                : t(
                    'settings.credentialVault.botFailed',
                    'Could not change the vault link. Reopen the tool and check its URL, existing credentials, and the vault entry.'
                  )}
            </p>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant={linked ? 'outline' : 'default'}
            className="justify-self-end"
            disabled={disabled || busy || (!linked && !id)}
            onClick={() => void apply()}
          >
            {linked
              ? t('settings.credentialVault.botUnlink', 'Unlink credential')
              : creating
                ? t('settings.credentialVault.botAdd', 'Add with credential')
                : t('settings.credentialVault.botLink', 'Link credential')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
