import { i18n, loadRendererUiLanguage } from '@/i18n/i18n'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { Toaster } from '../../../ui/sonner'
import { openLinkedUrlInWorkspaceBrowser } from './worktree-card-linked-url-open'
import { showBrowserOpenFailure } from '@/lib/browser/workspace/workspace-browser-open-failure-toast'
import {
  intentPresentation,
  openFailure
} from '@/lib/browser/workspace/workspace-browser-tab-presentation'

// Fixture-only invented workspace id; the toasts come from the production open and toast code.
const WORKSPACE = 'fixture-repo::/workspaces/example'

function Stage(): React.JSX.Element {
  return (
    <>
      <div className="h-[150px]" />
      <Toaster closeButton toastOptions={{ className: 'font-sans text-sm' }} />
    </>
  )
}

async function waitForToast(frame: HTMLElement): Promise<void> {
  const deadline = performance.now() + 3000
  while (!frame.ownerDocument.querySelector('[data-sonner-toast][data-mounted="true"]')) {
    if (performance.now() > deadline) {
      throw new Error('The failure toast never appeared')
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  // The toaster is fixed to the viewport corner; pin it inside the frame so the shot holds the
  // real toast card unchanged.
  const toaster = frame.ownerDocument.querySelector<HTMLElement>('[data-sonner-toaster]')
  if (toaster) {
    Object.assign(toaster.style, {
      position: 'absolute',
      top: '130px',
      left: '8px',
      right: 'auto',
      bottom: 'auto'
    })
  }
  await new Promise((resolve) => setTimeout(resolve, 400))
}

function hostErrorAt(language: 'en' | 'de') {
  return defineFixture({
    width: 400,
    render: () => <Stage />,
    interact: async (frame) => {
      await i18n.changeLanguage(await loadRendererUiLanguage(language))
      // The longest line a known code can produce.
      showBrowserOpenFailure(
        openFailure(
          intentPresentation({ kind: 'url' }, 'https://example.com/review/1').error,
          'remote browser open failed',
          undefined,
          {
            kind: 'host-error',
            stage: 'materialize',
            code: 'browser_profile_unavailable'
          }
        )
      )
      await waitForToast(frame)
    }
  })
}

export const hostErrorWorstCase = hostErrorAt('en')
export const hostErrorWorstCaseGerman = hostErrorAt('de')

export const computerNotFound = defineFixture({
  width: 400,
  render: () => <Stage />,
  interact: async (frame) => {
    await i18n.changeLanguage(await loadRendererUiLanguage('en'))
    // No such workspace in the fixture store, so the real open finds no computer for it.
    void openLinkedUrlInWorkspaceBrowser(WORKSPACE, 'https://example.com/review/1')
    await waitForToast(frame)
  }
})

export const notWebLink = defineFixture({
  width: 400,
  render: () => <Stage />,
  interact: async (frame) => {
    await i18n.changeLanguage(await loadRendererUiLanguage('en'))
    void openLinkedUrlInWorkspaceBrowser(WORKSPACE, 'mailto:someone@example.com')
    await waitForToast(frame)
  }
})
