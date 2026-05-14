import { useAppStore } from '@/store'
import { Mic } from 'lucide-react'

export function DictationIndicator() {
  const dictationState = useAppStore((s) => s.dictationState)
  const partialTranscript = useAppStore((s) => s.partialTranscript)

  if (dictationState !== 'listening' && dictationState !== 'starting') {
    return null
  }

  return (
    <div className="fixed bottom-12 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-lg bg-foreground/90 px-3 py-1.5 text-background text-sm shadow-lg">
      <Mic className={`h-4 w-4 ${dictationState === 'listening' ? 'animate-pulse' : ''}`} />
      <span>
        {dictationState === 'starting' ? 'Starting...' : partialTranscript || 'Listening...'}
      </span>
    </div>
  )
}
