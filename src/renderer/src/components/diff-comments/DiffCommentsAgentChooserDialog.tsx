import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { buildAgentStartupPlan } from '@/lib/tui-agent-startup'
import { formatDiffComments } from '@/lib/diff-comments-format'
import { AGENT_CATALOG } from '@/lib/agent-catalog'
import { ensureAgentStartupInTerminal, CLIENT_PLATFORM } from '@/lib/new-workspace'
import type { DiffComment, TuiAgent } from '../../../../shared/types'

// Why: we deliberately keep the chooser minimal — a list sourced from
// AGENT_CATALOG (same catalog the New Workspace composer uses) plus a Start
// button. Funneling through buildAgentStartupPlan keeps argv quoting and the
// stdin-after-start follow-up flow identical to the composer path, so agents
// like aider/goose still receive the prompt after their TUI boots.

export function DiffCommentsAgentChooserDialog({
  open,
  onOpenChange,
  worktreeId,
  comments
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  worktreeId: string
  comments: DiffComment[]
}): React.JSX.Element | null {
  const settings = useAppStore((s) => s.settings)
  const [selected, setSelected] = useState<TuiAgent>('claude')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleStart = async (): Promise<void> => {
    if (comments.length === 0) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const prompt = formatDiffComments(comments)
      const plan = buildAgentStartupPlan({
        agent: selected,
        prompt,
        cmdOverrides: settings?.agentCmdOverrides ?? {},
        platform: CLIENT_PLATFORM
      })
      if (!plan) {
        setError('Could not build startup plan.')
        return
      }
      const store = useAppStore.getState()
      const newTab = store.createTab(worktreeId)
      store.setActiveTab(newTab.id)
      store.setActiveTabType('terminal')
      store.queueTabStartupCommand(newTab.id, { command: plan.launchCommand })
      if (plan.followupPrompt) {
        // Why: stdin-after-start agents (aider, goose, amp) don't accept a
        // prompt via CLI flag. Polling for the expected process and typing the
        // prompt into the live TUI mirrors what the composer does for them.
        void ensureAgentStartupInTerminal({ worktreeId, startup: plan })
      }
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start agent.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Start agent with comments</DialogTitle>
        </DialogHeader>
        <div className="text-xs text-muted-foreground">
          Opens a new terminal tab and launches the agent preloaded with
          {comments.length === 1 ? ' 1 comment' : ` ${comments.length} comments`}.
        </div>
        <div className="max-h-64 overflow-y-auto rounded-md border border-border">
          {AGENT_CATALOG.map((entry) => (
            <label
              key={entry.id}
              className={`flex cursor-pointer items-center gap-2 border-b border-border/60 px-3 py-2 text-sm last:border-b-0 hover:bg-accent ${
                selected === entry.id ? 'bg-accent' : ''
              }`}
            >
              <input
                type="radio"
                name="diff-comments-agent"
                value={entry.id}
                checked={selected === entry.id}
                onChange={() => setSelected(entry.id)}
              />
              <span className="font-medium">{entry.label}</span>
              <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                {entry.cmd}
              </span>
            </label>
          ))}
        </div>
        {error && <div className="text-xs text-destructive">{error}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void handleStart()} disabled={busy || comments.length === 0}>
            Start
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
