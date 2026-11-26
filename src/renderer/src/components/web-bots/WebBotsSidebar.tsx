import {
  Archive,
  ArrowLeft,
  Cpu,
  Globe,
  MessageSquare,
  Pencil,
  Plus,
  Settings2,
  SlidersHorizontal,
  Trash2,
  Users
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/class-names'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  deleteWebBotExternalAgent,
  deleteWebBotGroup,
  removeCustomWebBotProvider,
  selectWebBotProvider,
  type AccountRecord,
  type ExternalAgentRecord,
  type GroupChatRecord,
  type ProviderInfo,
  type WebBotsSnapshot
} from '@/web/tauri-native-web-bots'
import { WebBotsSidebarAccounts } from './WebBotsSidebarAccounts'

type Props = {
  snapshot: WebBotsSnapshot | null
  selectedProvider: ProviderInfo | null
  providerAccounts: AccountRecord[]
  activeGroup: GroupChatRecord | null
  mode: 'accounts' | 'groups'
  onModeChange: (mode: 'accounts' | 'groups') => void
  onSelectGroup: (groupId: string) => void
  onClosePage: () => void
  onOpenAddProvider: () => void
  onOpenAccountDialog: (account: AccountRecord | null) => void
  onOpenCookieDialog: (account: AccountRecord) => void
  onOpenExternalAgentDialog: (agent: ExternalAgentRecord | null) => void
  onOpenGroupDialog: (group: GroupChatRecord | null) => void
  onOpenAdapters: () => void
  onOpenSettings: () => void
  onOpenSync: () => void
  onSnapshot: (snapshot: WebBotsSnapshot) => void
}

export function WebBotsSidebar({
  snapshot,
  selectedProvider,
  providerAccounts,
  activeGroup,
  mode,
  onModeChange,
  onSelectGroup,
  onClosePage,
  onOpenAddProvider,
  onOpenAccountDialog,
  onOpenCookieDialog,
  onOpenExternalAgentDialog,
  onOpenGroupDialog,
  onOpenAdapters,
  onOpenSettings,
  onOpenSync,
  onSnapshot
}: Props): React.JSX.Element {
  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-border bg-card/50">
      <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="xs" onClick={onClosePage} aria-label="返回">
            <ArrowLeft className="size-3.5" />
          </Button>
          <span className="text-sm font-semibold">Web Bots</span>
        </div>
        <div className="flex items-center gap-1 rounded-md bg-muted p-0.5">
          <Button
            variant={mode === 'accounts' ? 'secondary' : 'ghost'}
            size="xs"
            onClick={() => onModeChange('accounts')}
          >
            <Users className="size-3" />
            账号
          </Button>
          <Button
            variant={mode === 'groups' ? 'secondary' : 'ghost'}
            size="xs"
            onClick={() => onModeChange('groups')}
          >
            <MessageSquare className="size-3" />
            群聊
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-sleek p-2.5">
        <div className="mb-3">
          <div className="mb-1.5 flex items-center justify-between px-1">
            <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
              站点渠道
            </span>
            <Button
              variant="ghost"
              size="xs"
              onClick={onOpenAddProvider}
              aria-label="添加自定义站点"
            >
              <Plus className="size-3.5" />
            </Button>
          </div>
          <div className="flex flex-wrap gap-1">
            {(snapshot?.providers ?? []).map((provider) => {
              const active = selectedProvider?.id === provider.id
              return (
                <div key={provider.id} className="group flex items-center gap-0.5">
                  <Button
                    variant={active ? 'secondary' : 'outline'}
                    size="xs"
                    onClick={() => {
                      onModeChange('accounts')
                      void selectWebBotProvider(provider.id).then(onSnapshot)
                    }}
                  >
                    <Globe className="size-3" />
                    {provider.shortName}
                  </Button>
                  {provider.isCustom ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      className="px-1 opacity-60 hover:opacity-100"
                      onClick={() =>
                        void removeCustomWebBotProvider(provider.id)
                          .then(onSnapshot)
                          .catch((e) => toast.error(String(e)))
                      }
                      aria-label={`删除 ${provider.shortName}`}
                    >
                      <Trash2 className="size-3 text-destructive" />
                    </Button>
                  ) : null}
                </div>
              )
            })}
          </div>
        </div>

        <WebBotsSidebarAccounts
          selectedProvider={selectedProvider}
          providerAccounts={providerAccounts}
          activeAccount={snapshot?.activeAccount ?? null}
          warmAccounts={snapshot?.warmAccounts ?? []}
          isAccountsMode={mode === 'accounts'}
          onSelectAccount={() => onModeChange('accounts')}
          onOpenAccountDialog={onOpenAccountDialog}
          onOpenCookieDialog={onOpenCookieDialog}
          onSnapshot={onSnapshot}
        />

        <div className="mb-4">
          <div className="mb-1.5 flex items-center justify-between px-1">
            <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
              外部 API / CLI Agent
            </span>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => onOpenExternalAgentDialog(null)}
              aria-label="新增外部 Agent"
            >
              <Plus className="size-3.5" />
            </Button>
          </div>
          <div className="flex flex-col gap-1">
            {(snapshot?.externalAgents ?? []).map((ext) => (
              <div
                key={ext.id}
                className="group flex items-center justify-between gap-1.5 rounded-md px-2 py-1 text-xs hover:bg-accent/60"
              >
                <div className="flex min-w-0 items-center gap-1.5">
                  <Cpu className="size-3 shrink-0 text-muted-foreground" />
                  <span className="truncate">{ext.name}</span>
                  <Badge variant="outline" className="text-3xs">
                    {ext.kind === 'openai_api' ? 'API' : 'CLI'}
                  </Badge>
                </div>
                <div className="flex shrink-0 items-center opacity-0 group-hover:opacity-100">
                  <Button
                    variant="ghost"
                    size="xs"
                    className="px-1"
                    onClick={() => onOpenExternalAgentDialog(ext)}
                  >
                    <Pencil className="size-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="px-1"
                    onClick={() =>
                      void deleteWebBotExternalAgent(ext.id)
                        .then(onSnapshot)
                        .catch((e) => toast.error(String(e)))
                    }
                  >
                    <Trash2 className="size-3 text-destructive" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between px-1">
            <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
              多账号群聊
            </span>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => onOpenGroupDialog(null)}
              aria-label="新建群聊"
            >
              <Plus className="size-3.5" />
            </Button>
          </div>
          <div className="flex flex-col gap-1">
            {(snapshot?.groupChats ?? []).map((grp) => {
              const isActive = mode === 'groups' && activeGroup?.id === grp.id
              return (
                <div
                  key={grp.id}
                  className={cn(
                    'group flex items-center justify-between gap-1 rounded-md border px-2 py-1.5 text-xs',
                    isActive
                      ? 'border-border bg-accent text-accent-foreground'
                      : 'border-transparent hover:bg-accent/60'
                  )}
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                    onClick={() => {
                      onSelectGroup(grp.id)
                      onModeChange('groups')
                    }}
                  >
                    <MessageSquare className="size-3 shrink-0 text-muted-foreground" />
                    <span className="truncate font-medium">{grp.name}</span>
                  </button>
                  <div className="flex shrink-0 items-center opacity-0 group-hover:opacity-100">
                    <Button
                      variant="ghost"
                      size="xs"
                      className="px-1"
                      onClick={() => onOpenGroupDialog(grp)}
                    >
                      <Pencil className="size-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      className="px-1"
                      onClick={() =>
                        void deleteWebBotGroup(grp.id)
                          .then(onSnapshot)
                          .catch((e) => toast.error(String(e)))
                      }
                    >
                      <Trash2 className="size-3 text-destructive" />
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-border px-2 py-2">
        <Button variant="ghost" size="xs" onClick={onOpenSync}>
          <Archive className="size-3.5" />
          备份
        </Button>
        <Button variant="ghost" size="xs" onClick={onOpenAdapters}>
          <SlidersHorizontal className="size-3.5" />
          适配器
        </Button>
        <Button variant="ghost" size="xs" onClick={onOpenSettings}>
          <Settings2 className="size-3.5" />
          设置
        </Button>
      </div>
    </aside>
  )
}
