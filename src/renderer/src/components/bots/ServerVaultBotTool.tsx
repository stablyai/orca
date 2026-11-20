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
  BotToolVaultChange,
  ServerVaultTarget,
  VaultEntry
} from '../../../../shared/secure-storage/credential-vault'
import { changed } from './bot-tools-revision'

type Tool = Omit<BotToolVaultChange, 'binding'> & { linked: boolean }

export function ServerVaultBotTool({
  bot,
  tool,
  onChanged
}: {
  bot: BotRef
  tool: Tool
  onChanged: () => void
}): React.JSX.Element | null {
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
      target={{ environmentId: environment.id, pairingRevision: revision }}
      tool={tool}
      onChanged={onChanged}
    />
  )
}

function ServerVaultBotToolControl({
  target,
  tool,
  onChanged
}: {
  target: ServerVaultTarget
  tool: Tool
  onChanged: () => void
}): React.JSX.Element {
  const t = useTranslate()
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
    if (tool.linked) {
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
    setBusy(true)
    setError(false)
    setRestricted(false)
    try {
      const { linked, ...destination } = tool
      const result = await api.changeBotTool(
        { ...destination, binding: linked ? undefined : { id, scheme } },
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
    } finally {
      setBusy(false)
    }
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
        <Button type="button" variant="outline" size="sm">
          {tool.linked
            ? t('settings.credentialVault.botLinked', 'Vault credential linked')
            : t('settings.credentialVault.botUseVault', 'Use server vault')}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {tool.linked
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
          {!tool.linked && !error && entries === null ? (
            <p role="status" className="text-sm text-muted-foreground">
              {t('settings.credentialVault.loading', 'Loading vault…')}
            </p>
          ) : null}
          {!tool.linked && entries?.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t(
                'settings.credentialVault.botNoKeys',
                'Add an API key or token to this server’s vault first.'
              )}
            </p>
          ) : null}
          {!tool.linked && entries && entries.length > 0 ? (
            <>
              <div className="space-y-2">
                <Label>{t('settings.credentialVault.botKey', 'Vault entry')}</Label>
                <Select value={id} onValueChange={setId} disabled={busy}>
                  <SelectTrigger aria-label={t('settings.credentialVault.botKey', 'Vault entry')}>
                    <SelectValue
                      placeholder={t('settings.credentialVault.botChooseKey', 'Choose a key')}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {entries.map((entry) => (
                      <SelectItem key={entry.id} value={entry.id}>
                        {entry.name}
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
                    aria-label={t('settings.credentialVault.botHeader', 'Authentication header')}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
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
            variant={tool.linked ? 'outline' : 'default'}
            disabled={busy || (!tool.linked && !id)}
            onClick={() => void apply()}
          >
            {tool.linked
              ? t('settings.credentialVault.botUnlink', 'Unlink credential')
              : t('settings.credentialVault.botLink', 'Link credential')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
