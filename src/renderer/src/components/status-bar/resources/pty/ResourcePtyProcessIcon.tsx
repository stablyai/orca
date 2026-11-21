import { SquareTerminal } from 'lucide-react'
import { ClaudeIcon, OpenAIIcon } from '@/components/status-bar/accounts/provider-icons'
import { resourcePtyProcessBaseName } from './resource-pty-view-model'

export function ResourcePtyProcessIcon({
  process
}: {
  process: string | undefined
}): React.JSX.Element {
  const name = resourcePtyProcessBaseName(process)
  if (name === 'claude') {
    return <ClaudeIcon size={14} className="shrink-0" />
  }
  if (name === 'codex') {
    return <OpenAIIcon size={14} className="shrink-0 text-foreground" />
  }
  return <SquareTerminal aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
}
