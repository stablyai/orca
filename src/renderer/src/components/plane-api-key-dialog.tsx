import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAppStore } from '@/store'

export function PlaneApiKeyDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const connectPlane = useAppStore((state) => state.connectPlane)
  const [baseUrl, setBaseUrl] = useState('')
  const [workspaceSlug, setWorkspaceSlug] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const submit = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    const result = await connectPlane({ baseUrl, workspaceSlug, apiKey })
    setSaving(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setApiKey('')
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Plane access</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="plane-base-url">Base URL</Label>
            <Input
              id="plane-base-url"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://plane.example.com"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="plane-workspace">Workspace slug</Label>
            <Input
              id="plane-workspace"
              value={workspaceSlug}
              onChange={(event) => setWorkspaceSlug(event.target.value)}
              placeholder="workspace-slug"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="plane-api-key">Personal access token</Label>
            <Input
              id="plane-api-key"
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={saving || !baseUrl.trim() || !workspaceSlug.trim() || !apiKey.trim()}
          >
            {saving ? 'Connecting...' : 'Connect'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
