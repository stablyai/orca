import { useEffect, useState, type DragEvent as ReactDragEvent, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import {
  hasNativeFileDragTypes,
  NATIVE_FILE_DROP_TARGET
} from '../../../../shared/native-file-drop'

export type NativeChatComposerFrameProps = {
  commandMenu: ReactNode
  notice: ReactNode
  pendingPrompt: ReactNode
  children: ReactNode
}

export function NativeChatComposerFrame({
  commandMenu,
  notice,
  pendingPrompt,
  children
}: NativeChatComposerFrameProps): React.JSX.Element {
  const [nativeDragActive, setNativeDragActive] = useState(false)

  useEffect(() => {
    if (!nativeDragActive) {
      return
    }

    // Why: preload captures native file drops before React receives `drop`, so
    // the visual state clears from document-level drag completion instead.
    const clearNativeDragActive = (): void => setNativeDragActive(false)
    document.addEventListener('drop', clearNativeDragActive, true)
    document.addEventListener('dragend', clearNativeDragActive, true)
    window.addEventListener('blur', clearNativeDragActive)
    return () => {
      document.removeEventListener('drop', clearNativeDragActive, true)
      document.removeEventListener('dragend', clearNativeDragActive, true)
      window.removeEventListener('blur', clearNativeDragActive)
    }
  }, [nativeDragActive])

  const handleNativeDrag = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (hasNativeFileDragTypes(event.dataTransfer?.types)) {
      setNativeDragActive(true)
    }
  }

  const handleNativeDragLeave = (event: ReactDragEvent<HTMLDivElement>): void => {
    const nextTarget = event.relatedTarget
    if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
      setNativeDragActive(false)
    }
  }

  return (
    <div className="shrink-0 bg-background">
      <div className="px-3 py-2 sm:px-4">
        <div className="relative mx-auto w-full max-w-3xl">
          {commandMenu}
          <div
            data-native-file-drop-target={NATIVE_FILE_DROP_TARGET.composer}
            data-native-file-drop-active={nativeDragActive ? 'true' : undefined}
            onDragEnter={handleNativeDrag}
            onDragOver={handleNativeDrag}
            onDragLeave={handleNativeDragLeave}
            className={cn(
              'overflow-hidden rounded-xl border border-input bg-card shadow-xs transition-colors',
              'focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30',
              nativeDragActive && 'border-ring bg-accent/30 ring-[3px] ring-ring/30'
            )}
          >
            {pendingPrompt}
            <div className="p-1.5">
              {notice}
              {children}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
