import { useState } from 'react'
import { ArrowDown, ArrowUp, Cookie, Loader2, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/class-names'
import { Button } from '@/components/ui/button'
import {
  removeWebBotAccount,
  reorderWebBotAccounts,
  switchWebBotAccount,
  syncAllWebBotAccounts,
  type AccountKey,
  type AccountRecord,
  type ProviderInfo,
  type WebBotsSnapshot
} from '@/web/tauri-native-web-bots'

type Props = {
  selectedProvider: ProviderInfo | null
  providerAccounts: AccountRecord[]
  activeAccount: AccountKey | null
  warmAccounts: AccountKey[]
  isAccountsMode: boolean
  onSelectAccount: () => void
  onOpenAccountDialog: (account: AccountRecord | null) => void
  onOpenCookieDialog: (account: AccountRecord) => void
  onSnapshot: (snapshot: WebBotsSnapshot) => void
}

export function WebBotsSidebarAccounts({
  selectedProvider,
  providerAccounts,
  activeAccount,
  warmAccounts,
  isAccountsMode,
  onSelectAccount,
  onOpenAccountDialog,
  onOpenCookieDialog,
  onSnapshot
}: Props): React.JSX.Element {
  const [syncingAll, setSyncingAll] = useState(false)

  const handleMoveAccount = (index: number, delta: -1 | 1) => {
    if (!selectedProvider) {
      return
    }
    const targetIndex = index + delta
    if (targetIndex < 0 || targetIndex >= providerAccounts.length) {
      return
    }
    const uuids = providerAccounts.map((a) => a.uuid)
    const [moved] = uuids.splice(index, 1)
    uuids.splice(targetIndex, 0, moved)
    void reorderWebBotAccounts(selectedProvider.id, uuids)
      .then(onSnapshot)
      .catch((e) => toast.error(String(e)))
  }

  const handleSyncAll = async () => {
    setSyncingAll(true)
    try {
      const snap = await syncAllWebBotAccounts()
      onSnapshot(snap)
      toast.success('已完成保活账号状态与额度同步')
    } catch (e) {
      toast.error(String(e))
    } finally {
      setSyncingAll(false)
    }
  }

  return (
    <div className="mb-4">
      <div className="mb-1.5 flex items-center justify-between px-1">
        <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
          {selectedProvider ? `${selectedProvider.shortName} 账号` : '账号'}
        </span>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="xs"
            onClick={() => void handleSyncAll()}
            disabled={syncingAll || providerAccounts.length === 0}
            aria-label="全部同步"
          >
            {syncingAll ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => onOpenAccountDialog(null)}
            disabled={!selectedProvider}
            aria-label="新增账号"
          >
            <Plus className="size-3.5" />
          </Button>
        </div>
      </div>

      {providerAccounts.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-2.5 py-3 text-center text-xs text-muted-foreground">
          暂无账号，点击右上角 + 新增
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          {providerAccounts.map((acc, index) => {
            const isActive =
              activeAccount?.providerId === acc.providerId && activeAccount?.uuid === acc.uuid
            const isWarm = warmAccounts.some(
              (w) => w.providerId === acc.providerId && w.uuid === acc.uuid
            )
            return (
              <div
                key={acc.uuid}
                className={cn(
                  'group flex items-center justify-between gap-1.5 rounded-md border px-2 py-1.5 text-left transition-colors',
                  isActive && isAccountsMode
                    ? 'border-border bg-accent text-accent-foreground'
                    : 'border-transparent hover:bg-accent/60'
                )}
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 flex-col text-left"
                  onClick={() => {
                    onSelectAccount()
                    void switchWebBotAccount(acc.providerId, acc.uuid)
                      .then(onSnapshot)
                      .catch((e) => toast.error(String(e)))
                  }}
                >
                  <div className="flex items-center gap-1.5">
                    <span
                      className={cn(
                        'size-1.5 shrink-0 rounded-full',
                        acc.authState === 'authenticated'
                          ? 'bg-primary'
                          : acc.authState === 'logged_out'
                            ? 'bg-destructive'
                            : 'bg-muted-foreground/40'
                      )}
                    />
                    <span className="truncate text-xs font-medium">{acc.alias}</span>
                    {acc.quotaPercent !== null ? (
                      <span className="text-3xs text-muted-foreground">
                        {Math.round(acc.quotaPercent)}%
                      </span>
                    ) : null}
                    {isWarm ? <span className="text-3xs text-muted-foreground">保活</span> : null}
                  </div>
                  {acc.proxyUrl || acc.email || acc.quotaText ? (
                    <span className="truncate pl-3 text-2xs text-muted-foreground">
                      {acc.quotaText ?? acc.email ?? acc.proxyUrl}
                    </span>
                  ) : null}
                </button>
                <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100">
                  <Button
                    variant="ghost"
                    size="xs"
                    className="px-0.5"
                    disabled={index === 0}
                    onClick={() => handleMoveAccount(index, -1)}
                    aria-label="上移"
                  >
                    <ArrowUp className="size-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="px-0.5"
                    disabled={index === providerAccounts.length - 1}
                    onClick={() => handleMoveAccount(index, 1)}
                    aria-label="下移"
                  >
                    <ArrowDown className="size-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="px-0.5"
                    onClick={() => onOpenCookieDialog(acc)}
                    aria-label="管理 Cookie"
                  >
                    <Cookie className="size-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="px-0.5"
                    onClick={() => onOpenAccountDialog(acc)}
                    aria-label="编辑账号"
                  >
                    <Pencil className="size-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="px-0.5"
                    onClick={() =>
                      void removeWebBotAccount(acc.providerId, acc.uuid)
                        .then(onSnapshot)
                        .catch((e) => toast.error(String(e)))
                    }
                    aria-label="删除账号"
                  >
                    <Trash2 className="size-3 text-destructive" />
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
