import { useEffect, useState } from 'react'
import { Copy, Loader2 } from 'lucide-react'
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
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  exportWebBotCookies,
  importWebBotCookies,
  type AccountRecord,
  type WebBotsSnapshot
} from '@/web/tauri-native-web-bots'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  account: AccountRecord | null
  onUpdated: (snapshot: WebBotsSnapshot) => void
}

export function WebBotCookieDialog({
  open,
  onOpenChange,
  account,
  onUpdated
}: Props): React.JSX.Element {
  const [rawCookies, setRawCookies] = useState('')
  const [busy, setBusy] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      return
    }
    setRawCookies('')
    setError(null)
  }, [open, account])

  const handleImport = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!account) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const snapshot = await importWebBotCookies(account.providerId, account.uuid, rawCookies)
      onUpdated(snapshot)
      onOpenChange(false)
      toast.success('Cookie 已导入并刷新页面')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleExport = async () => {
    if (!account) {
      return
    }
    setExporting(true)
    setError(null)
    try {
      const json = await exportWebBotCookies(account.providerId, account.uuid)
      setRawCookies(json)
      await navigator.clipboard.writeText(json)
      toast.success('已导出当前账号 Cookie 并复制到剪贴板')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setExporting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="list" busy={busy || exporting}>
        <DialogHeader>
          <DialogTitle>Cookie 管理 · {account?.alias ?? ''}</DialogTitle>
          <DialogDescription>
            支持 JSON 数组、Netscape cookies.txt 或 HTTP Cookie: 请求头。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleImport} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="cookie-payload">Cookie 内容</Label>
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={handleExport}
                disabled={exporting || busy}
              >
                {exporting ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Copy className="size-3" />
                )}
                读取并复制当前 Cookie
              </Button>
            </div>
            <Textarea
              id="cookie-payload"
              rows={8}
              value={rawCookies}
              onChange={(e) => setRawCookies(e.target.value)}
              placeholder='[{"name":"...","value":"...","domain":"..."}] 或 Cookie: a=1; b=2'
              className="font-mono text-xs"
            />
          </div>

          {error ? <p className="text-xs text-destructive">{error}</p> : null}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              取消
            </Button>
            <Button type="submit" size="sm" disabled={busy || !rawCookies.trim()}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
              导入并应用
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
