import { useEffect, useState } from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { OrcaCloudQueuedPromptView } from './OrcaCloudQueuedPrompt'

const noop = (): void => {}
const PROMPT =
  'Find why the login test is flaky on CI and fix it. Run the suite three times to confirm.'

function promptFixture(prompt: string, editable: boolean, held = false) {
  return defineFixture({
    width: 420,
    render: () => (
      <div className="bg-background p-3">
        <OrcaCloudQueuedPromptView
          agentName="Claude"
          prompt={prompt}
          editable={editable}
          held={held}
          onQueue={noop}
        />
      </div>
    )
  })
}

/** Submitted without a prompt: type one while the sandbox provisions. */
export const empty = promptFixture('', true)
/** A prompt from the composer or typed here; editable until provisioning ends. */
export const queued = promptFixture(PROMPT, true)
/** Provisioning finished; the prompt is handed to the agent launch. */
export const sending = promptFixture(PROMPT, false)
/** N-04: the agent isn't set up for Orca Cloud, so the hint waits for that, not the workspace. */
export const emptyHeld = promptFixture('', true, true)
/** N-04: a queued prompt while the agent isn't set up. */
export const queuedHeld = promptFixture(PROMPT, true, true)

function BuildOutrunsTyping(): React.JSX.Element {
  const [editable, setEditable] = useState(true)
  useEffect(() => {
    const timer = window.setTimeout(() => setEditable(false), 400)
    return () => window.clearTimeout(timer)
  }, [])
  return (
    <div className="bg-background p-3">
      <OrcaCloudQueuedPromptView agentName="Claude" prompt="" editable={editable} onQueue={noop} />
    </div>
  )
}

/** Provisioning ended while a prompt was still being typed: the text stays, with what to do. */
export const tooLate = defineFixture({
  width: 420,
  render: () => <BuildOutrunsTyping />,
  interact: async (frame) => {
    const textarea = frame.querySelector('textarea')
    if (textarea) {
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setValue?.call(textarea, 'Also update the CI flake dashboard when done.')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    }
    await new Promise((resolve) => setTimeout(resolve, 700))
  }
})
