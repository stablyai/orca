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

  it('renders the API avatar_url when provided (works for github.com and GHE)', () => {
    const url = 'https://avatars.example.com/u/42?u=hash&v=4'
    ;({ root, container } = render(<GitHubUserAvatar login="enterprise-user" avatarUrl={url} />))
    const img = container.querySelector('img')
    expect(img?.getAttribute('src')).toBe(url)
  })

  it('falls back to the login URL when no avatar_url is available', () => {
    ;({ root, container } = render(<GitHubUserAvatar login="octocat" />))
    const img = container.querySelector('img')
    expect(img?.getAttribute('src')).toBe('https://github.com/octocat.png?size=64')
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

  it('derives initials from the login when no name is given', () => {
    ;({ root, container } = render(<GitHubUserAvatar login="octocat" />))
    act(() => {
      container?.querySelector('img')?.dispatchEvent(new Event('error'))
    })
    expect(container.textContent).toBe('OC')
  })

  it('retries when avatarUrl changes after an earlier src failed (late-arriving avatar)', () => {
    // Why: PR detail enrichment supplies avatar_url after first paint. A row that
    // 404s on the early login-based URL must recover once the real URL lands.
    ;({ root, container } = render(<GitHubUserAvatar login="enterprise-user" />))
    // First src is the login fallback; simulate the GHE 404.
    act(() => {
      container?.querySelector('img')?.dispatchEvent(new Event('error'))
    })
    expect(container.querySelector('img')).toBeNull()
    // Enriched avatar_url arrives → component must render the new image, not the
    // latched placeholder.
    const url = 'https://avatars.example.com/u/7?v=4'
    act(() => {
      root?.render(<GitHubUserAvatar login="enterprise-user" avatarUrl={url} />)
    })
    expect(container.querySelector('img')?.getAttribute('src')).toBe(url)
  })
})
