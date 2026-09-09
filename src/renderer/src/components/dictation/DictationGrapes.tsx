import { cn } from '@/lib/utils'

const GRAPES = [
  { base: 0.64, response: 0.45, lift: 1 },
  { base: 0.76, response: 0.75, lift: -1 },
  { base: 0.9, response: 1, lift: 1 },
  { base: 1, response: 1.25, lift: -1 },
  { base: 0.86, response: 0.9, lift: 1 },
  { base: 0.72, response: 1.1, lift: -1 },
  { base: 0.82, response: 0.7, lift: 1 },
  { base: 0.68, response: 0.55, lift: -1 },
  { base: 0.58, response: 0.35, lift: 1 }
] as const

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
      {GRAPES.map((grape, index) => {
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
