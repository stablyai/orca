import { useEffect, useState } from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { OrcaCloudQueuedPromptView } from './OrcaCloudQueuedPrompt'

const noop = (): void => {}
const PROMPT =
  'Find why the login test is flaky on CI and fix it. Run the suite three times to confirm.'

function promptFixture(prompt: string, editable: boolean) {
  return defineFixture({
    width: 420,
    render: () => (
      <div className="bg-background p-3">
        <OrcaCloudQueuedPromptView
          agentName="Claude Code"
          prompt={prompt}
          editable={editable}
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

function BuildOutrunsTyping(): React.JSX.Element {
  const [editable, setEditable] = useState(true)
  useEffect(() => {
    const timer = window.setTimeout(() => setEditable(false), 400)
    return () => window.clearTimeout(timer)
  }, [])
  return (
    <div className="bg-background p-3">
      <OrcaCloudQueuedPromptView
        agentName="Claude Code"
        prompt=""
        editable={editable}
        onQueue={noop}
      />
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
