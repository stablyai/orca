import { useEffect, useState } from 'react'
import { Loader2, RotateCcw } from 'lucide-react'
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
  getWebBotSiteAdapters,
  resetWebBotSiteAdapterOverrides,
  saveWebBotSiteAdapterOverrides,
  type SiteAdaptersSnapshot
} from '@/web/tauri-native-web-bots'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function WebBotSiteAdaptersDialog({ open, onOpenChange }: Props): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<SiteAdaptersSnapshot | null>(null)
  const [jsonText, setJsonText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      return
    }
    setError(null)
    void getWebBotSiteAdapters()
      .then((snap) => {
        setSnapshot(snap)
        setJsonText(
          snap.overrideJson.trim() ? snap.overrideJson : JSON.stringify(snap.adapters, null, 2)
        )
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err))
      })
  }, [open])

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const updated = await saveWebBotSiteAdapterOverrides(jsonText)
      setSnapshot(updated)
      setJsonText(updated.overrideJson || JSON.stringify(updated.adapters, null, 2))
      toast.success('站点适配器配置已保存并热生效')
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleReset = async () => {
    setBusy(true)
    setError(null)
    try {
      const resetSnap = await resetWebBotSiteAdapterOverrides()
      setSnapshot(resetSnap)
      setJsonText(JSON.stringify(resetSnap.adapters, null, 2))
      toast.success('已恢复内置站点适配器')
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
          <DialogTitle>站点选择器适配器（热覆盖）</DialogTitle>
          <DialogDescription>
            控制网页 Bot 的输入框、发送按钮、停止状态和回复 DOM
            选择器。目标站点改版时可在此直接覆盖。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSave} className="flex flex-col gap-3">
          {snapshot ? (
            <p className="truncate font-mono text-2xs text-muted-foreground">
              覆盖文件：{snapshot.overridePath}
            </p>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="adapters-json">适配器 JSON 数组</Label>
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={handleReset}
                disabled={busy}
              >
                <RotateCcw className="size-3" />
                恢复内置默认
              </Button>
            </div>
            <Textarea
              id="adapters-json"
              rows={14}
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
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
            <Button type="submit" size="sm" disabled={busy || !jsonText.trim()}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
              校验并保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
