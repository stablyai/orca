import { defineFixture } from '../../component-fixtures/component-fixture'
import { GlobalExternalLinkContextMenu } from './use-global-external-link-context-menu'

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

// Right-clicked a PR link in a markdown preview.
export const globalLinkMenu = defineFixture({
  width: 620,
  store: {
    activeWorktreeId: 'fixture-worktree',
    installedBrowsers: [
      { id: 'com.google.Chrome', name: 'Google Chrome' },
      { id: 'com.microsoft.edgemac', name: 'Microsoft Edge' },
      { id: 'com.apple.Safari', name: 'Safari' }
    ]
  },
  render: () => (
    <div className="h-[300px] rounded-md bg-muted/40 p-3 text-sm">
      <p>
        Follow-up is tracked in{' '}
        <a className="text-primary underline" href="https://github.com/stablyai/orca/pull/1234">
          stablyai/orca#1234
        </a>
        .
      </p>
      <GlobalExternalLinkContextMenu />
    </div>
  ),
  // Right-click the link, then expand "Open in" so the installed browsers are captured.
  interact: async (frame) => {
    const link = frame.querySelector('a')
    if (!link) {
      return
    }
    const bounds = link.getBoundingClientRect()
    link.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: bounds.left + 8,
        clientY: bounds.bottom
      })
    )
    await nextFrame()
    await nextFrame()
    const openIn = Array.from(
      document.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-sub-trigger"]')
    ).find((trigger) => trigger.textContent === 'Open in')
    openIn?.focus()
    openIn?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
  }
})
