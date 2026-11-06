// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { GitHubUserAvatar } from './github-user-avatar'

function render(node: React.JSX.Element): { root: Root; container: HTMLDivElement } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(node)
  })
  return { root, container }
}

describe('GitHubUserAvatar', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    root = null
    container = null
  })

  it('degrades to an initials placeholder when the image fails to load (GHE 404)', () => {
    ;({ root, container } = render(
      <GitHubUserAvatar login="enterprise-user" name="Ada Lovelace" />
    ))
    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    act(() => {
      img?.dispatchEvent(new Event('error'))
    })
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toBe('AL')
  })

  it('retries when avatarUrl changes after an earlier src failed (late-arriving avatar)', () => {
    ;({ root, container } = render(<GitHubUserAvatar login="enterprise-user" />))
    act(() => {
      container?.querySelector('img')?.dispatchEvent(new Event('error'))
    })
    expect(container.querySelector('img')).toBeNull()
    const url = 'https://avatars.example.com/u/7?v=4'
    act(() => {
      root?.render(<GitHubUserAvatar login="enterprise-user" avatarUrl={url} />)
    })
    expect(container.querySelector('img')?.getAttribute('src')).toBe(url)
  })
})
