import React from 'react'
import type { ChatUsage } from './chat-message-model'

function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`
  }
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}k`
  }
  return `${n}`
}

export function ChatUsageBar({ usage }: { usage: ChatUsage }): React.JSX.Element {
  return (
    <div className="shrink-0 px-3 py-0.5 flex items-center justify-end gap-3 text-[10px] text-muted-foreground">
      <span title="Context size of the latest request (input + cache tokens)">
        {formatTokens(usage.contextTokens)} ctx
      </span>
      <span title="Output tokens generated this conversation">
        {formatTokens(usage.outputTokens)} out
      </span>
      {/* Why: cost is $0 on subscription auth — only show when the API reports a real cost. */}
      {usage.costUsd > 0 && <span>${usage.costUsd.toFixed(2)}</span>}
    </div>
  )
}
