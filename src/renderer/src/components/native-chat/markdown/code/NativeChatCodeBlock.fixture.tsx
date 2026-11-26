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
