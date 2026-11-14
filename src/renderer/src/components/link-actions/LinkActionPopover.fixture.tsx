import { useState } from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { buildHttpLinkActions } from '@/lib/browser/navigation/http-link-destinations'
import { LinkActionPopover } from './LinkActionPopover'
import type { LinkActionRequest } from './link-action-request'

const PULL_REQUEST_URL = 'https://github.com/mancunianez/strofa/pull/21'

function PullRequestLink() {
  const [request, setRequest] = useState<LinkActionRequest | null>(null)
  return (
    <div className="h-72 p-8 pt-48 text-sm">
      PR created:{' '}
      <a
        href={PULL_REQUEST_URL}
        className="underline"
        onClick={(event) => {
          event.preventDefault()
          const anchor = event.currentTarget
          const bounds = anchor.getBoundingClientRect()
          setRequest({
            kind: 'url',
            destination: PULL_REQUEST_URL,
            anchorX: bounds.left,
            anchorY: bounds.top,
            ...buildHttpLinkActions({ primary: 'system', alternate: 'orca' }, () => {}, {
              worktreeId: 'fixture-worktree',
              url: PULL_REQUEST_URL,
              openInSourceGroup: () => {}
            }),
            restoreFocus: () => anchor.focus()
          })
        }}
      >
        {PULL_REQUEST_URL}
      </a>
      <LinkActionPopover request={request} onClose={() => setRequest(null)} />
    </div>
  )
}

export const pullRequest = defineFixture({
  width: 640,
  render: () => <PullRequestLink />,
  interact: async (frame) => {
    const link = frame.querySelector('a')
    if (!link) {
      throw new Error('Missing pull request link')
    }
    link.click()
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
})
