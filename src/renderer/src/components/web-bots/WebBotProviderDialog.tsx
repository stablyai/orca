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
import { addCustomWebBotProvider, type WebBotsSnapshot } from '@/web/tauri-native-web-bots'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onUpdated: (snapshot: WebBotsSnapshot) => void
}

const PROVIDER_PRESETS: { name: string; shortName: string; entryUrl: string }[] = [
  { name: 'Cue', shortName: 'Cue', entryUrl: 'https://cue.ai/' },
  { name: 'Dots', shortName: 'Dots', entryUrl: 'https://dots.ai/' },
  { name: 'ChatGPT', shortName: 'ChatGPT', entryUrl: 'https://chatgpt.com/' },
  { name: 'Claude Web', shortName: 'Claude', entryUrl: 'https://claude.ai/' },
  { name: 'Gemini Web', shortName: 'Gemini', entryUrl: 'https://gemini.google.com/' }
]

export function WebBotProviderDialog({ open, onOpenChange, onUpdated }: Props): React.JSX.Element {
  const [name, setName] = useState('')
  const [shortName, setShortName] = useState('')
  const [entryUrl, setEntryUrl] = useState('')
  const [allowedHosts, setAllowedHosts] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      return
    }
    setName('')
    setShortName('')
    setEntryUrl('')
    setAllowedHosts('')
    setError(null)
  }, [open])

  const applyPreset = (preset: { name: string; shortName: string; entryUrl: string }) => {
    setName(preset.name)
    setShortName(preset.shortName)
    setEntryUrl(preset.entryUrl)
    setError(null)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const hosts = allowedHosts
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean)
      const snapshot = await addCustomWebBotProvider({
        name: name.trim(),
        shortName: shortName.trim() || null,
        entryUrl: entryUrl.trim(),
        allowedHosts: hosts
      })
      onUpdated(snapshot)
      onOpenChange(false)
      toast.success('已添加自定义 Web Bot 站点')
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
          <DialogTitle>添加自定义 Web Bot 站点</DialogTitle>
          <DialogDescription>支持接入任意网页版 Bot（如 Cue、Dots 或自建站点）。</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-1.5">
            {PROVIDER_PRESETS.map((preset) => (
              <Button
                key={preset.name}
                type="button"
                variant="outline"
                size="xs"
                onClick={() => applyPreset(preset)}
              >
                {preset.shortName}
              </Button>
            ))}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="provider-name">站点名称</Label>
            <Input
              id="provider-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如 Cue"
              autoFocus
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="provider-short">简称（可选）</Label>
            <Input
              id="provider-short"
              value={shortName}
              onChange={(e) => setShortName(e.target.value)}
              placeholder="例如 Cue"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="provider-url">入口 URL</Label>
            <Input
              id="provider-url"
              value={entryUrl}
              onChange={(e) => setEntryUrl(e.target.value)}
              placeholder="https://example.com/"
              className="font-mono text-xs"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="provider-hosts">附加允许域名（可选，逗号或空格分隔）</Label>
            <Input
              id="provider-hosts"
              value={allowedHosts}
              onChange={(e) => setAllowedHosts(e.target.value)}
              placeholder="auth.example.com"
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
              disabled={saving}
            >
              取消
            </Button>
            <Button type="submit" size="sm" disabled={saving || !name.trim() || !entryUrl.trim()}>
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
              添加站点
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
