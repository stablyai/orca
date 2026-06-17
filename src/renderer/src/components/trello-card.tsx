import { useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { TrelloIcon } from '@/components/icons/TrelloIcon'

type TrelloCardProps = {
  onOpenConnectDialog: () => void
}

export function TrelloCard({ onOpenConnectDialog }: TrelloCardProps): React.JSX.Element {
  const trelloStatus = useAppStore((s) => s.trelloStatus)
  const trelloStatusChecked = useAppStore((s) => s.trelloStatusChecked)
  const disconnectTrello = useAppStore((s) => s.disconnectTrello)
  const testTrelloConnection = useAppStore((s) => s.testTrelloConnection)
  const [testing, setTesting] = useState(false)

  const handleTestConnection = async (): Promise<void> => {
    setTesting(true)
    try {
      const result = await testTrelloConnection()
      if (result.ok) {
        toast.success(`Trello connected as ${result.viewer.displayName || result.viewer.username}`)
      } else {
        toast.error(result.error)
      }
    } finally {
      setTesting(false)
    }
  }

  if (!trelloStatusChecked) {
    return (
      <div className="rounded-md border border-border/50 bg-muted/30 px-4 py-3">
        <div className="flex items-center gap-3">
          <TrelloIcon className="size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="text-sm font-medium">Trello</p>
            <p className="text-xs text-muted-foreground">
              Add Trello access to browse and link cards.
            </p>
          </div>
          <LoaderCircle className="size-4 shrink-0 animate-spin text-muted-foreground" />
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-md border border-border/50 bg-muted/30 px-4 py-3">
      <div className="flex items-center gap-3">
        <TrelloIcon className="size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="text-sm font-medium">Trello</p>
          <p className="text-xs text-muted-foreground">
            {trelloStatus.connected && trelloStatus.viewer
              ? `${trelloStatus.viewer.displayName} · Cards and boards`
              : 'Add Trello access to browse and link cards.'}
          </p>
        </div>
        {trelloStatus.connected ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleTestConnection()}
              disabled={testing}
            >
              {testing ? <LoaderCircle className="size-3.5 mr-1.5 animate-spin" /> : null}
              Test
            </Button>
            <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
              Connected
            </span>
            <button
              onClick={() => void disconnectTrello()}
              aria-label="Disconnect Trello"
              className="rounded-md p-1 text-muted-foreground/50 transition-colors hover:text-destructive"
            >
              <svg
                viewBox="0 0 24 24"
                aria-hidden
                className="size-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          </div>
        ) : (
          <button
            className="shrink-0 rounded-full border border-border/50 bg-muted/40 px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onClick={onOpenConnectDialog}
          >
            Add Trello access
          </button>
        )}
      </div>

      {trelloStatus.connected && (
        <div className="mt-3">
          <p className="text-[11px] text-muted-foreground/70">
            API key and token are stored on disk. Disconnect to remove them.
          </p>
        </div>
      )}
    </div>
  )
}
