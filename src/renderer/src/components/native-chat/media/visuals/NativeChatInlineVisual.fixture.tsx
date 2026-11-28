import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { i18n } from '../../../../i18n/i18n'
import { nativeChatAppearanceStyle } from '../../appearance/native-chat-appearance-style'
import '../../appearance/native-chat-appearance.css'
import { NativeChatInlineVisual } from './NativeChatInlineVisual'
import type { NativeChatVisualOwner } from './native-chat-visual-owner'

const OWNER: NativeChatVisualOwner = {
  target: { kind: 'local' },
  sessionId: 'visual-boundary-fixture',
  worktreeId: 'fixture'
}

const HTML = `<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body { margin: 0; padding: 16px; color: var(--foreground); background: var(--background); font-family: var(--font-sans); }
h2 { margin: 0 0 8px; font-size: 18px; }
p { margin: 0 0 12px; }
button { padding: 6px 10px; color: var(--foreground); background: var(--muted); border: 1px solid var(--border); border-radius: 6px; font: inherit; cursor: pointer; }
</style></head><body>
<h2>Request volume</h2><p>1,240 requests · +12% today</p>
<button type="button" onclick="document.getElementById('details').hidden = !document.getElementById('details').hidden">Show details</button>
<p id="details" hidden>Staging: 420 requests. Production: 820 requests.</p>
</body></html>`

function setupVisual(): void {
  const call = window.api.runtime.call
  window.api.runtime.call = async (request) => {
    if (request.method !== 'agentSession.readVisual') {
      return call(request)
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
    return {
      id: 'visual-boundary',
      ok: true,
      _meta: { runtimeId: 'fixture' },
      result: {
        ok: true,
        revision: 'visual-boundary-fixture',
        path: '/fixture/request-volume.html',
        html: HTML
      }
    }
  }
}

function Conversation({
  title,
  fontSize
}: {
  title: string | null
  fontSize: number
}): React.JSX.Element {
  const theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  return (
    <div
      className="native-chat-appearance p-4 text-sm text-chat-foreground"
      style={nativeChatAppearanceStyle({ theme, nativeChatAppearance: { fontSize } })}
    >
      <p>Here is the request-volume report.</p>
      <NativeChatInlineVisual
        owner={OWNER}
        file="request-volume-comparison-across-staging-and-production-environments.html"
        title={title}
      />
      <p>The report above is a separate visualization. This sentence continues the reply.</p>
    </div>
  )
}

function visual(width: number, title: string | null, fontSize = 13) {
  return defineFixture({
    width,
    setup: setupVisual,
    render: () => <Conversation title={title} fontSize={fontSize} />,
    interact: async () => {
      await i18n.changeLanguage('en')
      // Let the delayed read and the frame's first height report finish.
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
  })
}

export const wide = visual(720, 'Request volume')
export const narrow = visual(360, 'Request volume')
export const filename = visual(360, null)
export const largeText = visual(360, 'Request volume', 20)
