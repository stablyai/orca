import React from 'react'
import { Settings } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'

const SidebarToolbar = React.memo(function SidebarToolbar() {
  const setActiveView = useAppStore((s) => s.setActiveView)

  return (
    <div className="mt-auto shrink-0">
      {/* FORK: minimal toolbar — icons only, matching Kodu-style reference */}
      <div className="flex items-center justify-end px-3 py-2 border-t border-sidebar-border">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setActiveView('settings')}
              className="text-muted-foreground"
            >
              <Settings className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            Settings
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
})

export default SidebarToolbar
