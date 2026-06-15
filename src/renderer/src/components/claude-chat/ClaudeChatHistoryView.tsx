import React, { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'

type Session = {
  id: string
  date: string
  summary: string
}

type Props = {
  cwd: string
  onSelect: (sessionId: string) => void
}

export function ClaudeChatHistoryView({ cwd, onSelect }: Props): React.JSX.Element {
  const [sessions, setSessions] = useState<Session[] | null>(null)

  useEffect(() => {
    let cancelled = false
    // Why: reset to the loading state so a worktree switch never shows the
    // previous project's sessions while the new list is fetched.
    setSessions(null)
    window.api.claudeChat
      .listSessions({ cwd })
      .then((result) => {
        if (!cancelled) {
          setSessions(result)
        }
      })
      .catch(() => {
        // A failed listing reads as "no sessions" instead of an infinite spinner.
        if (!cancelled) {
          setSessions([])
        }
      })
    return () => {
      cancelled = true
    }
  }, [cwd])

  if (sessions === null) {
    return (
      <div className="flex flex-1 items-center justify-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 size={12} className="animate-spin" />
        Loading…
      </div>
    )
  }

  if (sessions.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        No previous sessions.
      </div>
    )
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-y-auto scrollbar-sleek px-2 py-2 gap-0.5">
      {sessions.map((session) => (
        <button
          key={session.id}
          type="button"
          onClick={() => onSelect(session.id)}
          className="w-full text-left rounded-md px-3 py-2 hover:bg-accent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <p className="text-[10px] text-muted-foreground mb-0.5">
            {new Date(session.date).toLocaleString()}
          </p>
          <p className="text-xs text-foreground truncate">{session.summary}</p>
        </button>
      ))}
    </div>
  )
}
