import { cn } from '@/lib/utils'
import { DICTATION_GRAPES } from '../../../../shared/dictation-audio-meter'

type DictationGrapesProps = {
  level: number
  active: boolean
  transitioning: boolean
}

export function DictationGrapes({ level, active, transitioning }: DictationGrapesProps) {
  const normalizedLevel = Math.min(1, Math.max(0, level))

  return (
    <div
      data-testid="dictation-grapes"
      aria-hidden="true"
      className={cn(
        'flex h-6 w-11 shrink-0 items-center justify-center gap-px overflow-hidden',
        transitioning && 'animate-pulse motion-reduce:animate-none'
      )}
    >
      {DICTATION_GRAPES.map((grape, index) => {
        const energy = active ? normalizedLevel : 0
        const scale = grape.base + energy * grape.response
        const verticalOffset = energy * grape.lift * 2
        return (
          <span
            key={index}
            className="size-1 shrink-0 rounded-full bg-current opacity-80 transition-transform duration-100 ease-out motion-reduce:transition-none"
            style={{ transform: `translateY(${verticalOffset}px) scale(${scale})` }}
          />
        )
      })}
    </div>
  )
}
