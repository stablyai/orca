import React, { useState } from 'react'
import { Loader2, Server } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'

export function ChatMcpPopover({ cwd }: { cwd: string | null }): React.JSX.Element {
  const [mcpServers, setMcpServers] = useState<string[] | null>(null)
  const [mcpLoading, setMcpLoading] = useState(false)

  const handleOpen = async (): Promise<void> => {
    if (!cwd || mcpServers !== null) {
      return
    }
    setMcpLoading(true)
    try {
      const servers = await window.api.claudeChat.listMcp({ cwd })
      setMcpServers(servers)
    } catch {
      setMcpServers([])
    } finally {
      setMcpLoading(false)
    }
  }

  return (
    <Popover
      onOpenChange={(open) => {
        if (open) {
          void handleOpen()
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="ghost" size="xs" className="h-6 px-2 text-xs gap-1" aria-label="MCP servers">
          <Server size={12} />
          MCP
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-3" align="start">
        <p className="text-xs font-medium mb-2">MCP Servers</p>
        {mcpLoading && (
          <p className="text-xs text-muted-foreground flex items-center gap-1.5">
            <Loader2 size={11} className="animate-spin" />
            Loading…
          </p>
        )}
        {!mcpLoading && mcpServers !== null && mcpServers.length === 0 && (
          <p className="text-xs text-muted-foreground">No MCP servers configured.</p>
        )}
        {!mcpLoading && mcpServers !== null && mcpServers.length > 0 && (
          <ul className="space-y-0.5">
            {mcpServers.map((name) => (
              <li key={name} className="text-xs py-0.5 text-foreground">
                {name}
              </li>
            ))}
          </ul>
        )}
        <p className="text-[10px] text-muted-foreground mt-2 leading-tight">
          Configured via Claude Code (<code className="font-mono">claude mcp add</code>).
        </p>
      </PopoverContent>
    </Popover>
  )
}
