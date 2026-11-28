import { useState } from 'react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { Toaster } from '../../ui/sonner'
import { NativeChatComposerPane } from './NativeChatComposerPane'

function WorkingComposer(): React.JSX.Element {
  const [working, setWorking] = useState(true)
  return (
    <div className="native-chat-appearance flex min-h-80 flex-col justify-end">
      <NativeChatComposerPane
        terminalTabId="escape-confirmation"
        paneKey="escape-confirmation"
        targetPtyId="escape-confirmation"
        agent="codex"
        isWorking={working}
        onStop={() => setWorking(false)}
      />
      <Toaster position="top-left" offset={32} />
    </div>
  )
}

export const working = defineFixture({
  width: 720,
  render: () => <WorkingComposer />
})

export const firstEscape = defineFixture({
  width: 720,
  render: () => <WorkingComposer />,
  interact: async (frame) => {
    const input = frame.querySelector<HTMLElement>('[contenteditable="true"], textarea')
    if (!input) {
      throw new Error('Composer input is missing')
    }
    input.focus()
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        bubbles: true,
        cancelable: true
      })
    )
    await new Promise((resolve) => setTimeout(resolve, 100))
    if (!document.querySelector('[data-sonner-toast]')) {
      throw new Error(`Escape confirmation is missing for ${input.outerHTML}`)
    }
  }
})
