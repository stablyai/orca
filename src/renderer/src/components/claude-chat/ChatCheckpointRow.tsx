import React, { useState } from 'react'
import { History, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type ChangedFile = { status: string; path: string }

type Props = {
  sha: string
  createdAt: string
  label: string
  cwd: string
  onReverted: (label: string) => void
}

function statusColor(_status: string): string {
  return 'text-muted-foreground'
}

// Why: keep the filename visible while truncating long dir prefixes.
function truncateStart(p: string, max = 40): string {
  if (p.length <= max) {
    return p
  }
  return `…${p.slice(p.length - max + 1)}`
}

function ChangedFileLine({ file }: { file: ChangedFile }): React.JSX.Element {
  return (
    <div className="flex items-center gap-1.5 py-0.5">
      <span
        className={cn('font-mono text-[10px] font-semibold w-3 shrink-0', statusColor(file.status))}
      >
        {file.status}
      </span>
      <span className="font-mono text-xs text-muted-foreground truncate" title={file.path}>
        {truncateStart(file.path)}
      </span>
    </div>
  )
}

// Compact hover controls attached to a user message (like the official GUI's
// per-message Rewind affordance) — no permanent divider/timestamp in the flow.
export function ChatCheckpointControls({
  sha,
  createdAt,
  cwd,
  onReverted
}: Props): React.JSX.Element {
  const [changedFiles, setChangedFiles] = useState<ChangedFile[] | null>(null)
  const [loadingFiles, setLoadingFiles] = useState(false)
  const [reverting, setReverting] = useState(false)

  const timeLabel = new Date(createdAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  })

  const handleShowChanges = async (): Promise<void> => {
    if (changedFiles !== null || loadingFiles) {
      return
    }
    setLoadingFiles(true)
    try {
      const files = await window.api.claudeChat.changedFiles({ cwd, sha })
      setChangedFiles(files)
    } catch {
      setChangedFiles([])
    } finally {
      setLoadingFiles(false)
    }
  }

  const handleRevert = async (): Promise<void> => {
    const confirmed = window.confirm(
      `Revert files to checkpoint at ${timeLabel}?\n\nFiles created after this checkpoint will remain.`
    )
    if (!confirmed) {
      return
    }
    setReverting(true)
    try {
      const ok = await window.api.claudeChat.revert({ cwd, sha })
      if (ok) {
        toast.success(`Reverted to checkpoint ${timeLabel}`)
        onReverted(timeLabel)
      } else {
        toast.error('Revert failed — see Claude Code output for details.')
      }
    } catch {
      toast.error('Revert failed — unexpected error.')
    } finally {
      setReverting(false)
    }
  }

  return (
    <div className="flex items-center gap-1 shrink-0">
      <span className="flex items-center gap-1 text-[10px] font-mono text-muted-foreground">
        <History size={10} />
        {timeLabel}
      </span>
      <div className="flex items-center gap-0.5 shrink-0">
        {/* Show changes popover */}
        <Popover
          onOpenChange={(open) => {
            if (open) {
              void handleShowChanges()
            }
          }}
        >
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="xs"
              className="h-5 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
            >
              Changes
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-3" align="center">
            <p className="text-xs font-medium mb-2">Changed since this checkpoint</p>
            {loadingFiles && (
              <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                <Loader2 size={11} className="animate-spin" />
                Loading…
              </p>
            )}
            {!loadingFiles && changedFiles !== null && changedFiles.length === 0 && (
              <p className="text-xs text-muted-foreground">No changes since this checkpoint.</p>
            )}
            {!loadingFiles && changedFiles !== null && changedFiles.length > 0 && (
              <div>
                {changedFiles.map((f) => (
                  <ChangedFileLine key={`${f.status}-${f.path}`} file={f} />
                ))}
              </div>
            )}
          </PopoverContent>
        </Popover>

        {/* Revert button */}
        <Button
          variant="ghost"
          size="xs"
          className="h-5 px-1.5 text-[10px] text-muted-foreground hover:text-destructive"
          onClick={() => void handleRevert()}
          disabled={reverting}
        >
          {reverting ? <Loader2 size={10} className="animate-spin" /> : 'Revert'}
        </Button>
      </div>
    </div>
  )
}
