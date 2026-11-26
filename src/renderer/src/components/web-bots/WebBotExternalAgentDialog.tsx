import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import {
  upsertWebBotExternalAgent,
  type ExternalAgentKind,
  type ExternalAgentRecord,
  type WebBotsSnapshot
} from '@/web/tauri-native-web-bots'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  editingAgent: ExternalAgentRecord | null
  onUpdated: (snapshot: WebBotsSnapshot) => void
}

export function WebBotExternalAgentDialog({
  open,
  onOpenChange,
  editingAgent,
  onUpdated
}: Props): React.JSX.Element {
  const [kind, setKind] = useState<ExternalAgentKind>('openai_api')
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('gpt-4o')
  const [command, setCommand] = useState('claude')
  const [argsText, setArgsText] = useState('-p {prompt}')
  const [workdir, setWorkdir] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      return
    }
    setKind(editingAgent?.kind ?? 'openai_api')
    setName(editingAgent?.name ?? '')
    setBaseUrl(editingAgent?.baseUrl || 'https://api.openai.com/v1')
    setApiKey(editingAgent?.apiKey ?? '')
    setModel(editingAgent?.model || 'gpt-4o')
    setCommand(editingAgent?.command || 'claude')
    setArgsText(editingAgent ? editingAgent.args.join(' ') : '-p {prompt}')
    setWorkdir(editingAgent?.workdir ?? '')
    setError(null)
  }, [open, editingAgent])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const args = argsText
        .split(/\s+/)
        .map((s) => s.trim())
        .filter(Boolean)
      const snapshot = await upsertWebBotExternalAgent({
        id: editingAgent?.id ?? null,
        kind,
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        model: model.trim(),
        command: command.trim(),
        args,
        workdir: workdir.trim() || null
      })
      onUpdated(snapshot)
      onOpenChange(false)
      toast.success(editingAgent ? '外部 Agent 已更新' : '已添加外部 Agent')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="form" busy={saving}>
        <DialogHeader>
          <DialogTitle>{editingAgent ? '编辑外部 Agent' : '添加外部 API / CLI Agent'}</DialogTitle>
          <DialogDescription>可加入多账号群聊，与网页版 Bot 混合协作。</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label>类型</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as ExternalAgentKind)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openai_api">OpenAI 兼容 API</SelectItem>
                <SelectItem value="local_cli">本地 CLI 工具</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ext-name">显示名称</Label>
            <Input
              id="ext-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={kind === 'openai_api' ? '例如 DeepSeek' : '例如 Claude Code'}
              autoFocus
            />
          </div>

          {kind === 'openai_api' ? (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ext-url">Base URL</Label>
                <Input
                  id="ext-url"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://api.deepseek.com/v1"
                  className="font-mono text-xs"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ext-model">模型名</Label>
                <Input
                  id="ext-model"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="deepseek-chat"
                  className="font-mono text-xs"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ext-key">API Key（可选，本机服务可留空）</Label>
                <Input
                  id="ext-key"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-..."
                  className="font-mono text-xs"
                />
              </div>
            </>
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ext-cmd">可执行命令</Label>
                <Input
                  id="ext-cmd"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="claude / codex"
                  className="font-mono text-xs"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ext-args">参数（用 {'{prompt}'} 占位或留空走 stdin）</Label>
                <Input
                  id="ext-args"
                  value={argsText}
                  onChange={(e) => setArgsText(e.target.value)}
                  placeholder="-p {prompt}"
                  className="font-mono text-xs"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ext-cwd">工作目录（可选）</Label>
                <Input
                  id="ext-cwd"
                  value={workdir}
                  onChange={(e) => setWorkdir(e.target.value)}
                  placeholder="D:\code\project"
                  className="font-mono text-xs"
                />
              </div>
            </>
          )}

          {error ? <p className="text-xs text-destructive">{error}</p> : null}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
              取消
            </Button>
            <Button type="submit" size="sm" disabled={saving || !name.trim()}>
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
