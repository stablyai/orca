import { defineFixture } from '../../../component-fixtures/component-fixture'
import { NativeChatComposer } from './NativeChatComposer'

function Composer(): React.JSX.Element {
  return (
    <div className="native-chat-appearance space-y-4 p-4">
      <NativeChatComposer
        terminalTabId="bidi-placeholder"
        paneKey="bidi-placeholder"
        targetPtyId="bidi-placeholder-pty"
        agent="codex"
        canSend
        launchPrompt={{
          placeholder:
            'This is a long placeholder that wraps in a narrow composer for direction checks.',
          onEmptySubmit: () => {}
        }}
      />
    </div>
  )
}
export const preview = defineFixture({ width: 360, render: () => <Composer /> })

export const rtl = defineFixture({
  width: 360,
  render: () => <Composer />,
  interact: async (frame) => {
    const editor = frame.querySelector<HTMLElement>('[data-native-chat-prompt-editor]')!
    editor.focus()
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    const trigger = frame.querySelector('button[aria-label^="Text direction:"]')!
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    const option = Array.from(
      document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')
    ).find((item) => item.textContent?.trim() === 'Right to left')!
    option.click()
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    const paragraph = editor.querySelector('p')!
    const hint = getComputedStyle(paragraph, '::before')
    if (
      getComputedStyle(paragraph).direction !== 'rtl' ||
      !['inline-start', 'right'].includes(hint.cssFloat) ||
      Number.parseFloat(hint.marginInlineEnd) >= 0 ||
      Number.parseFloat(hint.marginInlineStart) !== 0 ||
      editor.scrollWidth - editor.clientWidth > 2
    ) {
      throw new Error('RTL placeholder must follow the caret edge without horizontal overflow')
    }
  }
})
