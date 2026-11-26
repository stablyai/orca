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
import { Textarea } from '@/components/ui/textarea'
import {
  addWebBotAccount,
  testWebBotProxy,
  updateWebBotAccount,
  type AccountRecord,
  type ProxyTestResult,
  type WebBotsSnapshot
} from '@/web/tauri-native-web-bots'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  providerId: string
  providerName: string
  editingAccount: AccountRecord | null
  onUpdated: (snapshot: WebBotsSnapshot) => void
}

export function WebBotAccountDialog({
  open,
  onOpenChange,
  providerId,
  providerName,
  editingAccount,
  onUpdated
}: Props): React.JSX.Element {
  const [alias, setAlias] = useState('')
  const [proxyUrl, setProxyUrl] = useState('')
  const [timezone, setTimezone] = useState('')
  const [rawCookies, setRawCookies] = useState('')
  const [saving, setSaving] = useState(false)
  const [testingProxy, setTestingProxy] = useState(false)
  const [proxyResult, setProxyResult] = useState<ProxyTestResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      return
    }
    setAlias(editingAccount?.alias ?? '')
    setProxyUrl(editingAccount?.proxyUrl ?? '')
    setTimezone(editingAccount?.timezone ?? '')
    setRawCookies('')
    setProxyResult(null)
    setError(null)
  }, [open, editingAccount])

  const handleTestProxy = async () => {
    setTestingProxy(true)
    setProxyResult(null)
    try {
      const result = await testWebBotProxy(providerId, proxyUrl.trim() || null)
      setProxyResult(result)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setTestingProxy(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const snapshot = editingAccount
        ? await updateWebBotAccount({
            providerId: editingAccount.providerId,
            uuid: editingAccount.uuid,
            alias: alias.trim(),
            proxyUrl: proxyUrl.trim() || null,
            timezone: timezone.trim() || null
          })
        : await addWebBotAccount({
            providerId,
            alias: alias.trim(),
            proxyUrl: proxyUrl.trim() || null,
            timezone: timezone.trim() || null,
            rawCookies: rawCookies.trim() || null
          })
      onUpdated(snapshot)
      onOpenChange(false)
      toast.success(editingAccount ? '账号设置已更新' : '已创建隔离账号')
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
          <DialogTitle>
            {editingAccount ? `编辑账号 · ${editingAccount.alias}` : `新增 ${providerName} 账号`}
          </DialogTitle>
          <DialogDescription>
            每个账号使用独立的持久化浏览器数据目录与独立代理配置。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="webbot-alias">账号别名</Label>
            <Input
              id="webbot-alias"
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              placeholder={editingAccount ? '输入别名' : '留空将自动编号，如 Muse #1'}
              autoFocus
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="webbot-proxy">独立代理（可选）</Label>
            <div className="flex gap-2">
              <Input
                id="webbot-proxy"
                value={proxyUrl}
                onChange={(e) => setProxyUrl(e.target.value)}
                placeholder="http://127.0.0.1:7890 或 socks5://127.0.0.1:1080"
                className="font-mono text-xs"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleTestProxy}
                disabled={testingProxy}
              >
                {testingProxy ? <Loader2 className="size-3.5 animate-spin" /> : null}
                测试连接
              </Button>
            </div>
            {proxyResult ? (
              <p
                className={
                  proxyResult.ok ? 'text-xs text-muted-foreground' : 'text-xs text-destructive'
                }
              >
                {proxyResult.message}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="webbot-tz">时区备注（可选）</Label>
            <Input
              id="webbot-tz"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              placeholder="例如 Asia/Shanghai"
            />
          </div>

          {!editingAccount ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="webbot-cookies">初始 Cookie（可选）</Label>
              <Textarea
                id="webbot-cookies"
                rows={4}
                value={rawCookies}
                onChange={(e) => setRawCookies(e.target.value)}
                placeholder="支持粘贴 JSON 数组、Netscape cookies.txt 或 HTTP Cookie: 请求头"
                className="font-mono text-xs"
              />
            </div>
          ) : null}

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
            <Button type="submit" size="sm" disabled={saving}>
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {editingAccount ? '保存' : '创建'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
