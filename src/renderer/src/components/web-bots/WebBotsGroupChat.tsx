import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BookmarkPlus,
  Copy,
  Loader2,
  MessageSquarePlus,
  Pencil,
  RefreshCw,
  Send,
  Trash2
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  appendWebBotGroupContext,
  clearWebBotGroupMessages,
  newWebBotGroupTopic,
  retryWebBotGroupMessage,
  sendWebBotGroupMessage,
  updateWebBotGroup,
  type AccountKey,
  type AccountRecord,
  type ExternalAgentRecord,
  type GroupChatRecord,
  type GroupReplyStatus,
  type GroupWorkflowMode,
  type WebBotsSnapshot
} from '@/web/tauri-native-web-bots'

type Props = {
  group: GroupChatRecord
  accounts: AccountRecord[]
  externalAgents: ExternalAgentRecord[]
  onEditGroup: () => void
  onUpdated: (snapshot: WebBotsSnapshot) => void
}

const WORKFLOW_LABELS: Record<GroupChatRecord['workflowMode'], string> = {
  parallel: '并行讨论',
  review: '评审流',
  a2a_relay: 'A2A 接力'
}

const STATUS_LABELS: Record<GroupReplyStatus, string> = {
  queued: '排队中',
  sending: '发送中',
  streaming: '生成中',
  done: '已完成',
  needs_auth: '需登录',
  error: '失败'
}

function keyId(key: AccountKey): string {
  return `${key.providerId}:${key.uuid}`
}

export function WebBotsGroupChat({
  group,
  accounts,
  externalAgents,
  onEditGroup,
  onUpdated
}: Props): React.JSX.Element {
  const [composer, setComposer] = useState('')
  const [sending, setSending] = useState(false)
  const [topicBusy, setTopicBusy] = useState(false)
  const bottomRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [group.messages.length])

  const memberNameMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const acc of accounts) {
      map.set(`${acc.providerId}:${acc.uuid}`, acc.alias)
    }
    for (const ext of externalAgents) {
      const p = ext.kind === 'openai_api' ? 'api' : 'cli'
      map.set(`${p}:${ext.id}`, ext.name)
    }
    return map
  }, [accounts, externalAgents])

  const mentionQuery = useMemo(() => {
    const match = composer.match(/@([\w\u4e00-\u9fa5-]*)$/)
    return match ? match[1].toLowerCase() : null
  }, [composer])

  const mentionOptions = useMemo(() => {
    if (mentionQuery === null) {
      return []
    }
    const items = new Set<string>(['all'])
    for (const member of group.members) {
      const name = memberNameMap.get(keyId(member))
      if (name) {
        items.add(name)
      }
      items.add(member.providerId)
    }
    return [...items].filter((item) => item.toLowerCase().includes(mentionQuery)).slice(0, 8)
  }, [mentionQuery, group.members, memberNameMap])

  const applyMention = (token: string) => {
    setComposer((prev) => prev.replace(/@([\w\u4e00-\u9fa5-]*)$/, `@${token} `))
  }

  const handleSend = async () => {
    const text = composer.trim()
    if (!text || sending) {
      return
    }
    setSending(true)
    setComposer('')
    try {
      const snapshot = await sendWebBotGroupMessage(group.id, text)
      onUpdated(snapshot)
    } catch (err) {
      setComposer(text)
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }

  const handleNewTopic = async () => {
    setTopicBusy(true)
    try {
      const snapshot = await newWebBotGroupTopic(group.id)
      onUpdated(snapshot)
      toast.success('已开启新话题并重置网页会话绑定')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setTopicBusy(false)
    }
  }

  const handleClear = async () => {
    try {
      const snapshot = await clearWebBotGroupMessages(group.id)
      onUpdated(snapshot)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleRetry = async (messageId: string) => {
    try {
      const snapshot = await retryWebBotGroupMessage(group.id, messageId)
      onUpdated(snapshot)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleWorkflowChange = async (mode: GroupWorkflowMode) => {
    try {
      const snapshot = await updateWebBotGroup({
        groupId: group.id,
        name: group.name,
        members: group.members,
        workflowMode: mode,
        maxRelayHops: group.maxRelayHops,
        sharedContext: group.sharedContext,
        sharedSkills: group.sharedSkills,
        memberRoles: group.memberRoles
      })
      onUpdated(snapshot)
      toast.success(`已切换为「${WORKFLOW_LABELS[mode]}」`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleAppendContext = async (senderName: string, content: string) => {
    try {
      const snippet = `[${senderName}] ${content.trim()}`
      const snapshot = await appendWebBotGroupContext(group.id, snippet)
      onUpdated(snapshot)
      toast.success('已沉淀到群聊共享上下文')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleExportMarkdown = async () => {
    const md = [
      `# ${group.name}`,
      '',
      ...group.messages.map((m) => `### ${m.senderName}\n\n${m.content || m.error || ''}\n`)
    ].join('\n')
    await navigator.clipboard.writeText(md)
    toast.success('已复制群聊 Markdown 记录到剪贴板')
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col bg-background">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-sm font-semibold">{group.name}</h2>
          <Select
            value={group.workflowMode}
            onValueChange={(v) => void handleWorkflowChange(v as GroupWorkflowMode)}
          >
            <SelectTrigger size="sm" density="compact" className="h-6 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="parallel">并行讨论</SelectItem>
              <SelectItem value="review">评审流</SelectItem>
              <SelectItem value="a2a_relay">A2A 接力</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">{group.members.length} 位成员</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="outline" size="xs" onClick={() => void handleExportMarkdown()}>
            <Copy className="size-3" />
            导出 MD
          </Button>
          <Button variant="outline" size="xs" onClick={handleNewTopic} disabled={topicBusy}>
            {topicBusy ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <MessageSquarePlus className="size-3" />
            )}
            新话题
          </Button>
          <Button variant="outline" size="xs" onClick={handleClear}>
            <Trash2 className="size-3" />
            清空消息
          </Button>
          <Button variant="outline" size="xs" onClick={onEditGroup}>
            <Pencil className="size-3" />
            编辑群聊
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-card/40 px-4 py-1.5">
        {group.members.map((member) => {
          const id = keyId(member)
          const label = memberNameMap.get(id) ?? id
          const role = group.memberRoles.find((r) => keyId(r.member) === id)?.role
          return (
            <Badge key={id} variant="outline" className="text-2xs">
              {label}
              {role ? ` · ${role}` : ''}
            </Badge>
          )
        })}
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-sleek px-4 py-4">
        {group.messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-muted-foreground">
            <p className="text-sm font-medium text-foreground">
              在群聊中协同多个 Web Bot 与外部 Agent
            </p>
            <p className="max-w-md text-xs">
              输入内容即可同时派发给所有成员；使用 @成员名、@渠道名（如 @muse）或 @all 可精准路由。
            </p>
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-3">
            {group.messages.map((msg) => {
              const isUser = msg.role === 'user'
              const isPending =
                msg.status === 'queued' || msg.status === 'sending' || msg.status === 'streaming'
              return (
                <div
                  key={msg.id}
                  className={
                    isUser
                      ? 'ml-auto max-w-[82%] rounded-xl border border-border bg-accent px-3.5 py-2.5'
                      : 'mr-auto w-full rounded-xl border border-border bg-card px-3.5 py-2.5'
                  }
                >
                  <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-semibold">{msg.senderName}</span>
                      {!isUser ? (
                        <Badge
                          variant={
                            msg.status === 'error' || msg.status === 'needs_auth'
                              ? 'destructive'
                              : 'secondary'
                          }
                          className="text-3xs"
                        >
                          {isPending ? <Loader2 className="size-2.5 animate-spin" /> : null}
                          {STATUS_LABELS[msg.status]}
                        </Badge>
                      ) : null}
                      {msg.stageLabel ? (
                        <Badge variant="outline" className="text-3xs">
                          {msg.stageLabel}
                        </Badge>
                      ) : null}
                      {msg.autoRoutedChannel ? (
                        <Badge variant="outline" className="text-3xs">
                          @{msg.autoRoutedChannel}
                        </Badge>
                      ) : null}
                    </div>
                    {!isUser && msg.status === 'done' && msg.content.trim() ? (
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => void handleAppendContext(msg.senderName, msg.content)}
                      >
                        <BookmarkPlus className="size-3" />
                        沉淀结论
                      </Button>
                    ) : null}
                    {!isUser && (msg.status === 'error' || msg.status === 'needs_auth') ? (
                      <Button variant="ghost" size="xs" onClick={() => handleRetry(msg.id)}>
                        <RefreshCw className="size-3" />
                        重试
                      </Button>
                    ) : null}
                  </div>
                  {msg.content ? (
                    <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-foreground">
                      {msg.content}
                    </pre>
                  ) : isPending ? (
                    <p className="text-xs text-muted-foreground">等待节点响应…</p>
                  ) : null}
                  {msg.error ? (
                    <p className="mt-1.5 text-xs text-destructive">{msg.error}</p>
                  ) : null}
                </div>
              )
            })}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      <div className="relative border-t border-border bg-card/40 p-3">
        {mentionOptions.length > 0 ? (
          <div className="absolute bottom-full left-3 mb-1.5 flex flex-wrap gap-1 rounded-md border border-border bg-popover p-1.5 shadow-floating">
            {mentionOptions.map((opt) => (
              <Button
                key={opt}
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => applyMention(opt)}
              >
                @{opt}
              </Button>
            ))}
          </div>
        ) : null}
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <Textarea
            rows={2}
            value={composer}
            onChange={(e) => setComposer(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void handleSend()
              }
            }}
            placeholder="发送消息给群成员（支持 @成员名 / @muse / @all，Enter 发送，Shift+Enter 换行）"
            className="min-h-10 resize-none text-sm"
          />
          <Button size="sm" onClick={handleSend} disabled={sending || !composer.trim()}>
            {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            发送
          </Button>
        </div>
      </div>
    </div>
  )
}
