import { useEffect, useState } from 'react'
import { useSidekickUrl } from './useSidekickUrl'

function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() =>
    typeof document === 'undefined' ? true : document.visibilityState === 'visible'
  )
  useEffect(() => {
    const onChange = (): void => {
      setVisible(document.visibilityState === 'visible')
    }
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])
  return visible
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false
    }
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  })
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return
    }
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = (event: MediaQueryListEvent): void => setReduced(event.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return reduced
}

export function SidekickOverlay(): React.JSX.Element {
  const documentVisible = useDocumentVisible()
  const reducedMotion = usePrefersReducedMotion()
  const { url } = useSidekickUrl()
  const animate = documentVisible && !reducedMotion

  return (
    // Why: pointer-events-none so the app chrome underneath the sidekick stays
    // interactive — the sidekick is purely decorative. z-index sits just under
    // typical modal layers.
    <div
      aria-hidden
      className="pointer-events-none fixed bottom-4 right-16 z-40 h-[180px] w-[180px]"
    >
      <div
        className="flex size-full items-center justify-end"
        style={{
          animation: 'sidekick-bob 1.2s ease-in-out infinite',
          animationPlayState: animate ? 'running' : 'paused'
        }}
      >
        <style>
          {
            '@keyframes sidekick-bob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-4px); } }'
          }
        </style>
        <img src={url} alt="" className="max-h-full max-w-full object-contain" draggable={false} />
      </div>
    </div>
  )
}

export default SidekickOverlay
