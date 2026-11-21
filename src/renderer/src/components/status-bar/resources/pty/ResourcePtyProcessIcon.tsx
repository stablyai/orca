import { SquareTerminal } from 'lucide-react'
import { ClaudeIcon, OpenAIIcon } from '@/components/status-bar/accounts/provider-icons'

// Windows reports `claude.exe`, and some hosts report a full path.
function processBaseName(process: string | undefined): string {
  return (
    process
      ?.trim()
      .split(/[\\/]/)
      .pop()
      ?.toLowerCase()
      .replace(/\.exe$/, '') ?? ''
  )
}

export function ResourcePtyProcessIcon({
  process
}: {
  process: string | undefined
}): React.JSX.Element {
  const name = processBaseName(process)
  if (name === 'claude') {
    return <ClaudeIcon size={14} className="shrink-0" />
  }
  if (name === 'codex') {
    return <OpenAIIcon size={14} className="shrink-0 text-foreground" />
  }
  return <SquareTerminal aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
}
