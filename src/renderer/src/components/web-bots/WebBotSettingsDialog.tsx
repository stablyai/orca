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
import { Switch } from '@/components/ui/switch'
import {
  updateWebBotsSettings,
  type WebBotsSettings,
  type WebBotsSnapshot
} from '@/web/tauri-native-web-bots'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  settings: WebBotsSettings
  onUpdated: (snapshot: WebBotsSnapshot) => void
}

export function WebBotSettingsDialog({
  open,
  onOpenChange,
  settings,
  onUpdated
}: Props): React.JSX.Element {
  const [isolateSameProxy, setIsolateSameProxy] = useState(true)
  const [syncInterval, setSyncInterval] = useState('15')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) {
      return
    }
    setIsolateSameProxy(settings.isolateSameProxyKeepAlive)
    setSyncInterval(String(settings.silentSyncIntervalMins))
  }, [open, settings])

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    try {
      const mins = Math.max(0, Math.min(120, Number.parseInt(syncInterval, 10) || 0))
      const snapshot = await updateWebBotsSettings({
        isolateSameProxyKeepAlive: isolateSameProxy,
        silentSyncIntervalMins: mins
      })
      onUpdated(snapshot)
      onOpenChange(false)
      toast.success('Web Bots 设置已保存')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="form" busy={saving}>
        <DialogHeader>
          <DialogTitle>Web Bots 运行设置</DialogTitle>
          <DialogDescription>控制同代理账号保活隔离与后台巡检间隔。</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSave} className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
            <div className="flex flex-col gap-0.5">
              <Label htmlFor="isolate-proxy">同代理仅保活当前账号</Label>
              <span className="text-xs text-muted-foreground">
                未配独立代理或共享同一代理的同平台账号切换时，自动释放旧窗口以防限流。
              </span>
            </div>
            <Switch
              id="isolate-proxy"
              checked={isolateSameProxy}
              onCheckedChange={setIsolateSameProxy}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sync-interval">后台保活 / 巡检间隔（分钟，0–120，0 为仅手动）</Label>
            <Input
              id="sync-interval"
              type="number"
              min={0}
              max={120}
              value={syncInterval}
              onChange={(e) => setSyncInterval(e.target.value)}
            />
          </div>

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
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
