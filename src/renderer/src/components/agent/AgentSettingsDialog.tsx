import React from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { AgentsPane } from '@/components/settings/AgentsPane'
import { useAppStore } from '@/store'

type AgentSettingsDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export default function AgentSettingsDialog({
  open,
  onOpenChange
}: AgentSettingsDialogProps): React.JSX.Element | null {
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)

  if (!settings) {
    return null
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Why: widen past the default sm:max-w-lg so the agent rows have room
          for the name + pills + action cluster without wrapping, while a
          bounded max-h plus overflow-y keeps the list scrollable when many
          agents are detected. */}
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-sm">Agents</DialogTitle>
          <DialogDescription className="text-xs">
            Manage AI agents, set a default, and customize commands.
          </DialogDescription>
        </DialogHeader>
        <div className="scrollbar-sleek -mr-2 max-h-[70vh] overflow-y-auto pr-2">
          <AgentsPane settings={settings} updateSettings={updateSettings} />
        </div>
      </DialogContent>
    </Dialog>
  )
}
