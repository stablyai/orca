import { useEffect, useState } from 'react'
import { Copy, Download, Loader2, Upload } from 'lucide-react'
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
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import {
  exportWebBotsSyncBundle,
  importWebBotsSyncBundle,
  type WebBotsSnapshot
} from '@/web/tauri-native-web-bots'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onUpdated: (snapshot: WebBotsSnapshot) => void
}

export function WebBotSyncDialog({ open, onOpenChange, onUpdated }: Props): React.JSX.Element {
  const [tab, setTab] = useState<'export' | 'import'>('export')
  const [passphrase, setPassphrase] = useState('')
  const [includeCookies, setIncludeCookies] = useState(true)
  const [exportedText, setExportedText] = useState('')
  const [importText, setImportText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      return
    }
    setPassphrase('')
    setExportedText('')
    setImportText('')
    setError(null)
  }, [open])

  const handleExport = async (downloadFile: boolean) => {
    setBusy(true)
    setError(null)
    try {
      const res = await exportWebBotsSyncBundle(passphrase, includeCookies)
      setExportedText(res.bundleJson)
      if (downloadFile) {
        const blob = new Blob([res.bundleJson], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = res.filename
        anchor.click()
        URL.revokeObjectURL(url)
      } else {
        await navigator.clipboard.writeText(res.bundleJson)
      }
      toast.success(
        `已导出 ${res.accountCount} 个账号（含 ${res.cookieAccountCount} 个 Cookie 会话）`
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleFilePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) {
      return
    }
    const text = await file.text()
    setImportText(text)
  }

  const handleImport = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await importWebBotsSyncBundle(importText, passphrase)
      onUpdated(res.snapshot)
      toast.success(
        `导入完成：新增 ${res.summary.addedAccounts} / 更新 ${res.summary.updatedAccounts} 账号，恢复 ${res.summary.importedCookieAccounts} 份 Cookie，合并 ${res.summary.mergedGroups} 个群聊`
      )
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="list" scrollable busy={busy}>
        <DialogHeader>
          <DialogTitle>加密备份与 .maam 增量同步</DialogTitle>
          <DialogDescription>
            使用 AES-256-GCM（PBKDF2-SHA256）加密导出账号、代理、群聊与
            Cookie；导入采用只增不删的增量合并。
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as 'export' | 'import')}>
          <TabsList className="w-full">
            <TabsTrigger value="export">导出加密备份</TabsTrigger>
            <TabsTrigger value="import">导入 .maam 备份</TabsTrigger>
          </TabsList>

          <TabsContent value="export" className="mt-3 flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sync-export-pass">加密口令（至少 4 个字符）</Label>
              <Input
                id="sync-export-pass"
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder="用于解密恢复的口令"
              />
            </div>

            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
              <div className="flex flex-col gap-0.5">
                <Label htmlFor="sync-include-cookies">包含 Cookie 登录态</Label>
                <span className="text-xs text-muted-foreground">
                  从当前保活或已加载的 WebView 导出登录凭证，跨机恢复免重新扫码。
                </span>
              </div>
              <Switch
                id="sync-include-cookies"
                checked={includeCookies}
                onCheckedChange={setIncludeCookies}
              />
            </div>

            {exportedText ? (
              <Textarea rows={4} readOnly value={exportedText} className="font-mono text-2xs" />
            ) : null}

            {error ? <p className="text-xs text-destructive">{error}</p> : null}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void handleExport(false)}
                disabled={busy || passphrase.trim().length < 4}
              >
                <Copy className="size-3.5" />
                复制密文
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => void handleExport(true)}
                disabled={busy || passphrase.trim().length < 4}
              >
                {busy ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Download className="size-3.5" />
                )}
                导出 .maam 文件
              </Button>
            </DialogFooter>
          </TabsContent>

          <TabsContent value="import" className="mt-3">
            <form onSubmit={handleImport} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="sync-file">选择 .maam 文件或粘贴密文</Label>
                <Input
                  id="sync-file"
                  type="file"
                  accept=".maam,.json,application/json"
                  onChange={handleFilePick}
                />
                <Textarea
                  rows={5}
                  value={importText}
                  onChange={(e) => setImportText(e.target.value)}
                  placeholder='{"magic":"MAAM_SYNC","version":1,...}'
                  className="font-mono text-2xs"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="sync-import-pass">解密口令</Label>
                <Input
                  id="sync-import-pass"
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder="输入导出时设置的口令"
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
                <Button
                  type="submit"
                  size="sm"
                  disabled={busy || !importText.trim() || passphrase.trim().length < 4}
                >
                  {busy ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Upload className="size-3.5" />
                  )}
                  解密并增量合并
                </Button>
              </DialogFooter>
            </form>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
