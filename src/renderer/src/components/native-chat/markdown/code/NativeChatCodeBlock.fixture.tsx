import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { NativeChatCodeBlock } from './NativeChatCodeBlock'

const page = `<!doctype html>
<html><head><meta charset="utf-8"><title>Demo</title>
<style>body{font:14px system-ui;padding:16px}.b{background:#2563eb;color:#fff;border:0;padding:6px 12px;border-radius:6px}</style></head>
<body><h3>Mockup</h3><p>Rendered in a sandbox.</p><button class="b">Click</button></body></html>`

const block = (code: string) => (
  <div className="native-chat-appearance bg-background p-4">
    <NativeChatCodeBlock language="html">{code}</NativeChatCodeBlock>
  </div>
)
const showPreview = (frame: HTMLElement) =>
  [...frame.querySelectorAll<HTMLButtonElement>('[role="radio"]')].at(-1)?.click()

export const code = defineFixture({ width: 560, render: () => block(page) })
export const preview = defineFixture({
  width: 560,
  render: () => block(page),
  interact: showPreview
})
export const narrow = defineFixture({ width: 320, render: () => block(page) })
export const narrowPreview = defineFixture({
  width: 320,
  render: () => block(page),
  interact: showPreview
})
export const snippet = defineFixture({
  width: 560,
  render: () => block('<div class="card">hi</div>')
})

const longPath =
  "Error: Cannot find module '/Users/someone/Documents/projects/orca/centralized-notification/out/cli/index.js'\n    at Module._resolveFilename (node:internal/modules/cjs/loader:1145:15)"
const unlabeled = (code: string) => (
  <div className="native-chat-appearance bg-background p-4">
    <NativeChatCodeBlock>{code}</NativeChatCodeBlock>
  </div>
)
// Focus reveals the hover-only actions, so the shot shows them over the code.
const revealActions = (frame: HTMLElement) =>
  frame.querySelector<HTMLButtonElement>('[data-native-chat-code-block] button')?.focus()

export const unlabeledLongPath = defineFixture({
  width: 560,
  render: () => unlabeled(longPath),
  interact: revealActions
})
export const unlabeledNarrow = defineFixture({
  width: 320,
  render: () => unlabeled(longPath),
  interact: revealActions
})
export const unlabeledWrapped = defineFixture({
  width: 320,
  render: () => unlabeled(longPath),
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('[data-native-chat-code-block] button')?.click()
    revealActions(frame)
  }
})
