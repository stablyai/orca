import { useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Cookie,
  Home,
  Loader2,
  Pencil,
  RefreshCw,
  Sparkles
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  clearWebBotAccountData,
  navigateWebBotAccount,
  reloadWebBotAccount,
  syncWebBotAccount,
  type AccountRecord,
  type ProviderInfo,
  type WebBotsSnapshot
} from '@/web/tauri-native-web-bots'

type Props = {
  activeAccount: AccountRecord | null
  selectedProvider: ProviderInfo | null
  onOpenCookie: (account: AccountRecord) => void
  onOpenEdit: (account: AccountRecord) => void
  onSnapshot: (snapshot: WebBotsSnapshot) => void
}

export function WebBotAccountToolbar({
  activeAccount,
  selectedProvider,
  onOpenCookie,
  onOpenEdit,
  onSnapshot
}: Props): React.JSX.Element {
  const [syncing, setSyncing] = useState(false)

  if (!activeAccount) {
    return (
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <span className="text-sm text-muted-foreground">
          {selectedProvider ? selectedProvider.name : 'Web Bots'}
        </span>
      </div>
    )
  }

  const runNav = async (action: 'back' | 'forward' | 'home') => {
    try {
      await navigateWebBotAccount({
        providerId: activeAccount.providerId,
        uuid: activeAccount.uuid,
        action
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleSync = async () => {
    setSyncing(true)
    try {
      const snap = await syncWebBotAccount(activeAccount.providerId, activeAccount.uuid)
      onSnapshot(snap)
      toast.success('已同步当前账号登录态与额度')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
      <div className="flex min-w-0 items-center gap-1.5">
        <Button variant="ghost" size="xs" onClick={() => void runNav('back')} aria-label="后退">
          <ArrowLeft className="size-3.5" />
        </Button>
        <Button variant="ghost" size="xs" onClick={() => void runNav('forward')} aria-label="前进">
          <ArrowRight className="size-3.5" />
        </Button>
        <Button variant="ghost" size="xs" onClick={() => void runNav('home')} aria-label="主页">
          <Home className="size-3.5" />
        </Button>
        <span className="ml-1 truncate text-sm font-semibold">{activeAccount.alias}</span>
        <Badge variant="outline">{activeAccount.providerId}</Badge>
        {activeAccount.quotaText ? (
          <Badge variant="secondary" className="max-w-44 truncate text-2xs">
            {activeAccount.quotaText}
          </Badge>
        ) : activeAccount.quotaPercent !== null ? (
          <Badge variant="secondary" className="text-2xs">
            已用 {Math.round(activeAccount.quotaPercent)}%
          </Badge>
        ) : null}
        {activeAccount.proxyUrl ? (
          <Badge variant="secondary" className="max-w-44 truncate font-mono text-2xs">
            {activeAccount.proxyUrl}
          </Badge>
        ) : null}
      </div>

      <div className="flex items-center gap-1.5">
        <Button variant="outline" size="xs" onClick={() => void handleSync()} disabled={syncing}>
          {syncing ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3" />}
          同步状态
        </Button>
        <Button variant="outline" size="xs" onClick={() => onOpenCookie(activeAccount)}>
          <Cookie className="size-3" />
          Cookie
        </Button>
        <Button
          variant="outline"
          size="xs"
          onClick={() =>
            void reloadWebBotAccount(activeAccount.providerId, activeAccount.uuid)
              .then(onSnapshot)
              .catch((e) => toast.error(String(e)))
          }
        >
          <RefreshCw className="size-3" />
          刷新
        </Button>
        <Button
          variant="outline"
          size="xs"
          onClick={() =>
            void clearWebBotAccountData(activeAccount.providerId, activeAccount.uuid)
              .then(onSnapshot)
              .catch((e) => toast.error(String(e)))
          }
        >
          退出清空
        </Button>
        <Button variant="outline" size="xs" onClick={() => onOpenEdit(activeAccount)}>
          <Pencil className="size-3" />
          设置
        </Button>
      </div>
    </div>
  )
}
