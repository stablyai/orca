// The chevron's "Copy link" menu: a loopback sign-in link says where it works (muted second line);
// a link that works anywhere (billing, GitHub, help) doesn't.
import { ExternalLink } from 'lucide-react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { signInLinkHint } from '../orca-sign-in-link'
import { OpenExternalSplitButton } from './OpenExternalSplitButton'

function menuOpen(label: string, link: string, hint?: string) {
  return defineFixture({
    width: 360,
    render: () => (
      <div className="h-48 p-4">
        <OpenExternalSplitButton
          link={link}
          onClick={() => undefined}
          {...(hint ? { copyHint: hint } : {})}
        >
          {label}
          <ExternalLink aria-hidden />
        </OpenExternalSplitButton>
      </div>
    ),
    interact: async (frame) => {
      frame
        .querySelector<HTMLButtonElement>('[data-open-external-chevron]')
        ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  })
}

/** Orca sign-in (loopback): "Copy link" with "Open it in any browser on this computer." under it. */
export const signInLinkMenu = menuOpen(
  'Sign in to Orca',
  'http://127.0.0.1:5555/auth?state=s',
  signInLinkHint()
)
/** A link that works anywhere: just "Copy link". */
export const plainLinkMenu = menuOpen('Open billing portal', 'https://billing.example/portal')
