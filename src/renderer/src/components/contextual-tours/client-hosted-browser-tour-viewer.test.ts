import { afterEach, describe, expect, it } from 'vitest'
import { setClientHostedBrowserTourViewer } from './client-hosted-browser-tour-viewer'
import { getLocalizedContextualTourStepCopy } from './contextual-tour-step-copy'

const introBody = () => getLocalizedContextualTourStepCopy('client-hosted-browser-intro')?.body

describe('client-hosted browser intro copy', () => {
  afterEach(() => setClientHostedBrowserTourViewer(null))

  it('tells a teammate that only localhost goes through the shared host', () => {
    setClientHostedBrowserTourViewer('teammate')
    expect(introBody()).toBe(
      'Remote browser tabs now render on this device. Localhost pages go through the shared host; other sites load from your network.'
    )
  })

  it('keeps the through-the-host line for the owner’s own computers', () => {
    for (const viewer of ['own-computer', null] as const) {
      setClientHostedBrowserTourViewer(viewer)
      expect(introBody()).toBe(
        'Remote browser tabs now render on this device. Network traffic still goes through the remote host.'
      )
    }
  })
})
