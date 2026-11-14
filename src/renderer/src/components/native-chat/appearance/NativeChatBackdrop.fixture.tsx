import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Terminal } from '@xterm/xterm'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { NativeChatPaneCover } from '../../terminal-pane/chat/NativeChatPaneCover'
import {
  NATIVE_CHAT_APPEARANCE_ROOT_CLASS,
  nativeChatAppearanceStyle
} from './native-chat-appearance-style'

function ChatCanvas({ sample }: { sample: string }): React.JSX.Element {
  return (
    <div
      data-native-chat-root="true"
      className={`${NATIVE_CHAT_APPEARANCE_ROOT_CLASS} relative h-full w-full`}
      style={nativeChatAppearanceStyle({ theme: 'dark' })}
    >
      <div data-paint-sample={sample} className="absolute left-4 top-4 size-8" />
    </div>
  )
}

function TerminalPane({
  covered,
  sample
}: {
  covered: boolean
  sample: string
}): React.JSX.Element {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const [terminal] = useState(() => new Terminal())
  useEffect(() => () => terminal.dispose(), [terminal])
  return (
    <div ref={setContainer} className="pane relative h-32 w-40">
      <div className="xterm-container absolute inset-0">
        <div data-terminal-ink className="absolute inset-0" />
      </div>
      {!covered && <div data-paint-sample={sample} className="absolute left-4 top-4 size-8" />}
      {covered && container
        ? createPortal(
            <NativeChatPaneCover pane={{ container, terminal }}>
              <ChatCanvas sample={sample} />
            </NativeChatPaneCover>,
            container
          )
        : null}
    </div>
  )
}

function Backdrops(): React.JSX.Element {
  const [covered, setCovered] = useState(false)
  useEffect(() => {
    const root = document.documentElement
    const previousMaterial = root.getAttribute('data-window-material')
    const previousOpacity = root.style.getPropertyValue('--orca-window-surface-opacity')
    root.dataset.windowMaterial = 'blur'
    root.style.setProperty('--orca-window-surface-opacity', '0.3')
    return () => {
      if (previousMaterial === null) {
        root.removeAttribute('data-window-material')
      } else {
        root.setAttribute('data-window-material', previousMaterial)
      }
      root.style.setProperty('--orca-window-surface-opacity', previousOpacity)
    }
  }, [])
  const terminalBackground = 'color-mix(in srgb, var(--background) 30%, transparent)'
  return (
    <>
      <button onClick={() => setCovered(!covered)}>Toggle split chat</button>
      <div data-test-backdrop className="flex gap-4">
        <div data-paint-sample="bare" className="size-8 shrink-0" />
        <div data-terminal-chat-pane="" style={{ background: terminalBackground }}>
          <TerminalPane covered sample="single" />
        </div>
        <div
          data-terminal-chat-pane={covered ? '' : undefined}
          className="has-multiple-panes flex"
          style={{ background: terminalBackground }}
        >
          <TerminalPane covered={covered} sample="split" />
          <TerminalPane covered={false} sample="neighbor" />
        </div>
        <div data-structured-agent-session-overlay-tab-id="fixture" className="h-32 w-40">
          <ChatCanvas sample="structured" />
        </div>
      </div>
    </>
  )
}

export const material = defineFixture({
  width: 800,
  render: () => <Backdrops />
})
