import { useState } from 'react'
import { Loader2, Share2 } from 'lucide-react'
import type { ArtifactPublishResult, ArtifactWriteRequest } from '../../../../shared/artifacts'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { publishArtifactFromSurface } from './artifact-publish-flow'

export function ArtifactPublishButton({
  createRequest,
  className,
  disabled,
  onPublished
}: {
  createRequest: () => Promise<ArtifactWriteRequest>
  className?: string
  disabled?: boolean
  onPublished?: (result: ArtifactPublishResult) => void
}): React.JSX.Element {
  const [publishing, setPublishing] = useState(false)
  const connecting = useAppStore((state) => state.orcaProfileConnecting)
  const blocked = disabled || publishing || connecting

  const publish = async (): Promise<void> => {
    if (blocked) {
      return
    }
    setPublishing(true)
    try {
      const result = await publishArtifactFromSurface(createRequest)
      if (result) {
        onPublished?.(result)
      }
    } finally {
      setPublishing(false)
    }
  }

  const label = translate(
    'auto.components.artifacts.ArtifactPublishButton.a4a49da6af',
    'Share as artifact'
  )
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className={cn('shrink-0', className)}
          disabled={blocked}
          onClick={() => void publish()}
          aria-label={label}
        >
          {publishing ? <Loader2 className="animate-spin" /> : <Share2 />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
