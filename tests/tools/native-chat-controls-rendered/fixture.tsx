import React, { useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { NativeChatPaneHeader } from '@/components/native-chat/NativeChatPaneHeader'
import { NativeChatFindBar } from '@/components/native-chat/NativeChatFindBar'
import { NativeChatContextClearFade } from '@/components/native-chat/NativeChatContextClearFade'
import { nativeChatAppearanceStyle } from '@/components/native-chat/native-chat-appearance-style'
import { useNativeChatFind } from '@/components/native-chat/use-native-chat-find'
import { TooltipProvider } from '@/components/ui/tooltip'
import './fixture.css'

function Fixture() {
  const root = useRef<HTMLDivElement>(null)
  const find = useNativeChatFind(false, root, useRef(null), useRef(null))
  return (
    <TooltipProvider>
      <button onClick={() => find.open?.()}>Open Find</button>
      <div
        ref={root}
        className="native-chat-appearance relative m-6 flex h-96 w-[480px] flex-col"
        style={nativeChatAppearanceStyle({ theme: 'dark' })}
      >
        <NativeChatPaneHeader
          tabId="fixture"
          worktreeId="fixture"
          groupId="fixture"
          nativeChat={{ sessionId: 'fixture', agent: undefined }}
          focused
          colorScheme="dark"
        />
        <NativeChatContextClearFade clearing={false}>
          {find.isOpen && <NativeChatFindBar find={find} isVisible />}
          <p data-native-chat-transcript-column className="pt-20">
            alpha alpha
          </p>
          <textarea aria-label="Composer" />
        </NativeChatContextClearFade>
      </div>
    </TooltipProvider>
  )
}
const root = document.getElementById('root')
if (root) {
  createRoot(root).render(<Fixture />)
}
