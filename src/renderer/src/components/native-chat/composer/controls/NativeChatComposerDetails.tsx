import type { ComponentProps } from 'react'
import { useAppStore } from '@/store'
import { NativeChatComposerWorkspace } from './NativeChatComposerWorkspace'

/** The row under the composer, only while Settings > Chat UI > Composer details is on. */
export function NativeChatComposerDetails(
  props: ComponentProps<typeof NativeChatComposerWorkspace>
): React.JSX.Element | null {
  const shown = useAppStore((state) => state.settings?.nativeChatComposerDetails === true)
  return shown ? <NativeChatComposerWorkspace {...props} /> : null
}
