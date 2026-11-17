// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BitbucketServerCredentialsDialog } from './bitbucket-server-credentials-dialog'

let root: Root | null = null

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount()
    })
  }
  root = null
  document.body.innerHTML = ''
})

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('BitbucketServerCredentialsDialog', () => {
  it('shows a thrown connect error without the Electron IPC prefix', async () => {
    const connect = vi.fn(async () => {
      throw new Error(
        "Error invoking remote method 'bitbucketServer:connect': Error: EACCES: permission denied"
      )
    })
    Object.assign(window, { api: { bitbucketServer: { connect } } })
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <BitbucketServerCredentialsDialog
          open
          onOpenChange={() => {}}
          initialBaseUrl="https://bitbucket.example.com"
        />
      )
    })

    const token = document.body.querySelector<HTMLInputElement>('input[type="password"]')
    await act(async () => {
      typeInto(token!, 'secret')
    })
    const connectButton = Array.from(document.body.querySelectorAll('button')).find(
      (candidate) => candidate.textContent === 'Connect'
    )
    await act(async () => {
      connectButton?.click()
    })

    expect(connect).toHaveBeenCalledOnce()
    expect(document.body.textContent).toContain('EACCES: permission denied')
    expect(document.body.textContent).not.toContain('Error invoking remote method')
  })
})
