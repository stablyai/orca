import { Loader2, Pencil, Trash2 } from 'lucide-react'
import type {
  CustomProviderAccount,
  CustomProviderUsageResult
} from '../../../../shared/custom-provider-types'
import { Button } from '../ui/button'
import { Switch } from '../ui/switch'
import { getCustomProviderIconOption } from './custom-provider-icon-options'
import { translate } from '@/i18n/i18n'

type CustomProviderAccountCardProps = {
  account: CustomProviderAccount
  usage: CustomProviderUsageResult | undefined
  busy: boolean
  onToggleEnabled: (account: CustomProviderAccount, enabled: boolean) => void
  onEdit: (account: CustomProviderAccount) => void
  onRemove: (account: CustomProviderAccount) => void
}

function usageSummary(
  account: CustomProviderAccount,
  usage: CustomProviderUsageResult | undefined
): { text: string; tone: 'ok' | 'error' | 'muted' } {
  if (!account.enabled) {
    return {
      text: translate('auto.components.settings.CustomProviderAccountCard.disabled', 'Disabled'),
      tone: 'muted'
    }
  }
  if (!usage) {
    return {
      text: translate(
        'auto.components.settings.CustomProviderAccountCard.pending',
        'Not fetched yet'
      ),
      tone: 'muted'
    }
  }
  if (usage.status === 'fetching') {
    return {
      text: translate('auto.components.settings.CustomProviderAccountCard.fetching', 'Fetching…'),
      tone: 'muted'
    }
  }
  if (usage.usedPercent != null) {
    const stale = usage.status !== 'ok'
    const percent = `${Math.round(usage.usedPercent)}%`
    return {
      text: stale
        ? translate(
            'auto.components.settings.CustomProviderAccountCard.staleSuffix',
            '{{value0}} (stale)',
            {
              value0: percent
            }
          )
        : percent,
      tone: stale ? 'error' : 'ok'
    }
  }
  return {
    text:
      usage.error ?? translate('auto.components.settings.CustomProviderAccountCard.error', 'Error'),
    tone: 'error'
  }
}

export function CustomProviderAccountCard({
  account,
  usage,
  busy,
  onToggleEnabled,
  onEdit,
  onRemove
}: CustomProviderAccountCardProps): React.JSX.Element {
  const { Icon } = getCustomProviderIconOption(account.icon)
  const summary = usageSummary(account, usage)

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border/50 bg-card/40 px-4 py-3">
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{account.displayName}</span>
          <span
            className={
              summary.tone === 'ok'
                ? 'text-[11px] text-emerald-500'
                : summary.tone === 'error'
                  ? 'text-[11px] text-red-400'
                  : 'text-[11px] text-muted-foreground'
            }
          >
            {summary.text}
          </span>
        </div>
        <p className="truncate text-xs text-muted-foreground">{account.usageUrl}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Switch
          checked={account.enabled}
          disabled={busy}
          onCheckedChange={(checked) => onToggleEnabled(account, checked)}
          aria-label={translate(
            'auto.components.settings.CustomProviderAccountCard.toggleAria',
            'Enable {{value0}}',
            { value0: account.displayName }
          )}
        />
        <Button
          variant="ghost"
          size="xs"
          onClick={() => onEdit(account)}
          disabled={busy}
          aria-label={translate(
            'auto.components.settings.CustomProviderAccountCard.editAria',
            'Edit'
          )}
        >
          {busy ? <Loader2 className="size-3 animate-spin" /> : <Pencil className="size-3" />}
        </Button>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => onRemove(account)}
          disabled={busy}
          className="text-muted-foreground hover:text-destructive"
          aria-label={translate(
            'auto.components.settings.CustomProviderAccountCard.removeAria',
            'Remove'
          )}
        >
          <Trash2 className="size-3" />
        </Button>
      </div>
    </div>
  )
}
