import type { JSX } from 'react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'

type SetupGuideProgressRingProps = {
  done: number
  total: number
  className?: string
  sizeClassName?: string
  strokeWidth?: number
  tooltipLabel?: string
}

export function SetupGuideProgressRing({
  done,
  total,
  className,
  sizeClassName = 'size-5',
  strokeWidth = 2,
  tooltipLabel
}: SetupGuideProgressRingProps): JSX.Element {
  const boundedTotal = Math.max(total, 1)
  const boundedDone = Math.min(Math.max(done, 0), boundedTotal)
  const progressLabel = `${boundedDone}/${boundedTotal}`
  const viewBoxSize = 20
  const center = viewBoxSize / 2
  const radius = 7
  const circumference = 2 * Math.PI * radius
  const offset = circumference * (1 - boundedDone / boundedTotal)

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'relative flex shrink-0 items-center justify-center text-muted-foreground',
            sizeClassName,
            className
          )}
          aria-label={translate(
            'auto.components.setup.guide.SetupGuideProgressRing.dac3a4724a',
            '{{value0}} of {{value1}} setup steps complete',
            { value0: boundedDone, value1: boundedTotal }
          )}
        >
          <svg className={cn('-rotate-90', sizeClassName)} viewBox="0 0 20 20" aria-hidden>
            <circle
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              stroke="currentColor"
              strokeWidth={strokeWidth}
              className="opacity-25"
            />
            <circle
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              stroke="currentColor"
              strokeWidth={strokeWidth}
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={offset}
            />
          </svg>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {tooltipLabel ?? progressLabel}
      </TooltipContent>
    </Tooltip>
  )
}
