import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/store/index'
import { Button } from '@/components/ui/button'
import { isTauriNativeHost } from '@/web/tauri-native-host'
import {
  getWebBotsState,
  setWebBotViewport,
  subscribeWebBotsState,
  type AccountRecord,
  type ExternalAgentRecord,
  type GroupChatRecord,
  type WebBotsSnapshot
} from '@/web/tauri-native-web-bots'
import { WebBotAccountDialog } from './WebBotAccountDialog'
import { WebBotAccountToolbar } from './WebBotAccountToolbar'
import { WebBotCookieDialog } from './WebBotCookieDialog'
import { WebBotExternalAgentDialog } from './WebBotExternalAgentDialog'
import { WebBotGroupDialog } from './WebBotGroupDialog'
import { WebBotProviderDialog } from './WebBotProviderDialog'
import { WebBotSettingsDialog } from './WebBotSettingsDialog'
import { WebBotSiteAdaptersDialog } from './WebBotSiteAdaptersDialog'
import { WebBotSyncDialog } from './WebBotSyncDialog'
import { WebBotsGroupChat } from './WebBotsGroupChat'
import { WebBotsSidebar } from './WebBotsSidebar'

export default function WebBotsPage(): React.JSX.Element {
  const activeView = useAppStore((s) => s.activeView)
  const activeModal = useAppStore((s) => s.activeModal)
  const closeWebBotsPage = useAppStore((s) => s.closeWebBotsPage)
  const tauriNative = isTauriNativeHost()

  const [snapshot, setSnapshot] = useState<WebBotsSnapshot | null>(null)
  const [mode, setMode] = useState<'accounts' | 'groups'>('accounts')
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null)

  const [accountDialogOpen, setAccountDialogOpen] = useState(false)
  const [editingAccount, setEditingAccount] = useState<AccountRecord | null>(null)
  const [cookieDialogAccount, setCookieDialogAccount] = useState<AccountRecord | null>(null)
  const [providerDialogOpen, setProviderDialogOpen] = useState(false)
  const [extDialogOpen, setExtDialogOpen] = useState(false)
  const [editingExt, setEditingExt] = useState<ExternalAgentRecord | null>(null)
  const [groupDialogOpen, setGroupDialogOpen] = useState(false)
  const [editingGroup, setEditingGroup] = useState<GroupChatRecord | null>(null)
  const [adaptersDialogOpen, setAdaptersDialogOpen] = useState(false)
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false)
  const [syncDialogOpen, setSyncDialogOpen] = useState(false)

  const viewportRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!tauriNative) {
      return
    }
    let mounted = true
    void getWebBotsState()
      .then((snap) => {
        if (mounted) {
          setSnapshot(snap)
        }
      })
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : String(err))
      })
    const unsubscribe = subscribeWebBotsState((snap) => {
      if (mounted) {
        setSnapshot(snap)
      }
    })
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [tauriNative])

  const anyDialogOpen =
    accountDialogOpen ||
    cookieDialogAccount !== null ||
    providerDialogOpen ||
    extDialogOpen ||
    groupDialogOpen ||
    adaptersDialogOpen ||
    settingsDialogOpen ||
    syncDialogOpen ||
    activeModal !== null

  const shouldShowWebView =
    tauriNative &&
    activeView === 'web-bots' &&
    mode === 'accounts' &&
    Boolean(snapshot?.activeAccount) &&
    !anyDialogOpen

  const syncViewport = useCallback(
    (visible: boolean) => {
      if (!tauriNative) {
        return
      }
      const el = viewportRef.current
      if (!visible || !el) {
        void setWebBotViewport({ x: 0, y: 0, width: 0, height: 0, visible: false })
        return
      }
      const rect = el.getBoundingClientRect()
      if (rect.width <= 10 || rect.height <= 10) {
        void setWebBotViewport({ x: 0, y: 0, width: 0, height: 0, visible: false })
        return
      }
      void setWebBotViewport({
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
        visible: true
      })
    },
    [tauriNative]
  )

  useEffect(() => {
    syncViewport(shouldShowWebView)
    const el = viewportRef.current
    if (!shouldShowWebView || !el) {
      return
    }
    const observer = new ResizeObserver(() => {
      syncViewport(true)
    })
    observer.observe(el)
    const onResize = () => syncViewport(true)
    window.addEventListener('resize', onResize)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', onResize)
    }
  }, [
    shouldShowWebView,
    syncViewport,
    snapshot?.activeAccount?.providerId,
    snapshot?.activeAccount?.uuid
  ])

  useEffect(() => {
    return () => {
      if (tauriNative) {
        void setWebBotViewport({ x: 0, y: 0, width: 0, height: 0, visible: false })
      }
    }
  }, [tauriNative])

  const selectedProvider = useMemo(() => {
    if (!snapshot) {
      return null
    }
    return (
      snapshot.providers.find((p) => p.id === snapshot.selectedProviderId) ??
      snapshot.providers[0] ??
      null
    )
  }, [snapshot])

  const providerAccounts = useMemo(() => {
    if (!snapshot || !selectedProvider) {
      return []
    }
    return snapshot.accounts.filter((a) => a.providerId === selectedProvider.id)
  }, [snapshot, selectedProvider])

  const activeAccountRecord = useMemo(() => {
    if (!snapshot?.activeAccount) {
      return null
    }
    return (
      snapshot.accounts.find(
        (a) =>
          a.providerId === snapshot.activeAccount?.providerId &&
          a.uuid === snapshot.activeAccount?.uuid
      ) ?? null
    )
  }, [snapshot])

  const activeGroup = useMemo(() => {
    if (!snapshot || snapshot.groupChats.length === 0) {
      return null
    }
    const targetId = selectedGroupId ?? snapshot.activeGroupId
    return snapshot.groupChats.find((g) => g.id === targetId) ?? snapshot.groupChats[0] ?? null
  }, [snapshot, selectedGroupId])

  if (!tauriNative) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-center">
        <div className="max-w-md rounded-xl border border-border bg-card p-6">
          <h2 className="text-base font-semibold">Web Bots 仅在 Tauri 桌面端可用</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            请使用 Orca Tauri 桌面端运行以启用原生 WebView 多账号容器隔离与群聊编排。
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-1 min-h-0 min-w-0 bg-background text-foreground">
      <WebBotsSidebar
        snapshot={snapshot}
        selectedProvider={selectedProvider}
        providerAccounts={providerAccounts}
        activeGroup={activeGroup}
        mode={mode}
        onModeChange={setMode}
        onSelectGroup={setSelectedGroupId}
        onClosePage={closeWebBotsPage}
        onOpenAddProvider={() => setProviderDialogOpen(true)}
        onOpenAccountDialog={(acc) => {
          setEditingAccount(acc)
          setAccountDialogOpen(true)
        }}
        onOpenCookieDialog={setCookieDialogAccount}
        onOpenExternalAgentDialog={(ext) => {
          setEditingExt(ext)
          setExtDialogOpen(true)
        }}
        onOpenGroupDialog={(grp) => {
          setEditingGroup(grp)
          setGroupDialogOpen(true)
        }}
        onOpenAdapters={() => setAdaptersDialogOpen(true)}
        onOpenSettings={() => setSettingsDialogOpen(true)}
        onOpenSync={() => setSyncDialogOpen(true)}
        onSnapshot={setSnapshot}
      />

      <main className="flex flex-1 min-w-0 min-h-0 flex-col">
        {mode === 'accounts' ? (
          <>
            <WebBotAccountToolbar
              activeAccount={activeAccountRecord}
              selectedProvider={selectedProvider}
              onOpenCookie={setCookieDialogAccount}
              onOpenEdit={(acc) => {
                setEditingAccount(acc)
                setAccountDialogOpen(true)
              }}
              onSnapshot={setSnapshot}
            />

            <div ref={viewportRef} className="relative flex flex-1 min-h-0 bg-background">
              {!activeAccountRecord ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
                  <p className="text-sm font-medium">
                    当前站点暂无选中账号，添加一个独立隔离容器开始使用
                  </p>
                  <Button
                    size="sm"
                    onClick={() => {
                      setEditingAccount(null)
                      setAccountDialogOpen(true)
                    }}
                    disabled={!selectedProvider}
                  >
                    <Plus className="size-4" />
                    新增 {selectedProvider?.shortName ?? ''} 账号
                  </Button>
                </div>
              ) : null}
            </div>
          </>
        ) : activeGroup ? (
          <WebBotsGroupChat
            group={activeGroup}
            accounts={snapshot?.accounts ?? []}
            externalAgents={snapshot?.externalAgents ?? []}
            onEditGroup={() => {
              setEditingGroup(activeGroup)
              setGroupDialogOpen(true)
            }}
            onUpdated={setSnapshot}
          />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
            <p className="text-sm font-medium">尚未创建多账号协作群聊</p>
            <Button
              size="sm"
              onClick={() => {
                setEditingGroup(null)
                setGroupDialogOpen(true)
              }}
            >
              <Plus className="size-4" />
              新建群聊
            </Button>
          </div>
        )}
      </main>

      {selectedProvider ? (
        <WebBotAccountDialog
          open={accountDialogOpen}
          onOpenChange={setAccountDialogOpen}
          providerId={selectedProvider.id}
          providerName={selectedProvider.shortName}
          editingAccount={editingAccount}
          onUpdated={setSnapshot}
        />
      ) : null}

      <WebBotCookieDialog
        open={cookieDialogAccount !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCookieDialogAccount(null)
          }
        }}
        account={cookieDialogAccount}
        onUpdated={setSnapshot}
      />

      <WebBotProviderDialog
        open={providerDialogOpen}
        onOpenChange={setProviderDialogOpen}
        onUpdated={setSnapshot}
      />

      <WebBotExternalAgentDialog
        open={extDialogOpen}
        onOpenChange={setExtDialogOpen}
        editingAgent={editingExt}
        onUpdated={setSnapshot}
      />

      <WebBotGroupDialog
        open={groupDialogOpen}
        onOpenChange={setGroupDialogOpen}
        editingGroup={editingGroup}
        accounts={snapshot?.accounts ?? []}
        externalAgents={snapshot?.externalAgents ?? []}
        onUpdated={setSnapshot}
      />

      <WebBotSiteAdaptersDialog open={adaptersDialogOpen} onOpenChange={setAdaptersDialogOpen} />

      <WebBotSyncDialog
        open={syncDialogOpen}
        onOpenChange={setSyncDialogOpen}
        onUpdated={setSnapshot}
      />

      {snapshot ? (
        <WebBotSettingsDialog
          open={settingsDialogOpen}
          onOpenChange={setSettingsDialogOpen}
          settings={snapshot.settings}
          onUpdated={setSnapshot}
        />
      ) : null}
    </div>
  )
}
