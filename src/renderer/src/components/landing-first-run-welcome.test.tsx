// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../store'
import type { Repo } from '../../../shared/repo-types'

vi.mock('./landing-preflight-runtime', () => ({
  useLandingPreflightRuntime: () => ({ preflightIssues: [] })
}))
vi.mock('./landing-github-star-state', () => ({
  useLandingOrcaStarState: () => ['hidden', () => undefined]
}))

const { default: Landing } = await import('./Landing')

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
const openModal = vi.fn()
const addNonGitFolder = vi.fn()
const getHomeFolderPath = vi.fn()

function button(label: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label
  )
  if (!match) {
    throw new Error(`missing ${label} button`)
  }
  return match
}

function render(repos: Repo[]): void {
  useAppStore.setState({ repos, openModal, addNonGitFolder })
  act(() => root.render(<Landing />))
}

beforeEach(() => {
  openModal.mockReset()
  addNonGitFolder.mockReset().mockResolvedValue(null)
  getHomeFolderPath.mockReset().mockResolvedValue('/Users/someone')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the welcome reads only the repos API's home folder.
  ;(window as unknown as { api: unknown }).api = { repos: { getHomeFolderPath } }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('first-run welcome', () => {
  it('with no project, asks for a project instead of pointing at the sidebar', () => {
    render([])
    expect(container.querySelector('[data-landing-first-run-welcome]')).not.toBeNull()
    expect(container.textContent).toContain('Start with a project')
    expect(container.textContent).not.toContain('Select a workspace from the sidebar')
    expect(container.textContent).not.toContain('ORCA')
  })

  it('Add project opens the Add project dialog', () => {
    render([])
    act(() => button('Add project').click())
    expect(openModal).toHaveBeenCalledWith('add-repo')
  })

  it('the home-folder link opens the home folder as the "~" folder project, once per click', async () => {
    let finishAdd: () => void = () => undefined
    addNonGitFolder.mockReturnValue(
      new Promise<null>((resolve) => (finishAdd = () => resolve(null)))
    )
    render([])
    const link = button('Or open a terminal in your home folder')
    await act(async () => {
      link.click()
      link.click()
    })
    expect(getHomeFolderPath).toHaveBeenCalledTimes(1)
    expect(addNonGitFolder).toHaveBeenCalledTimes(1)
    expect(addNonGitFolder).toHaveBeenCalledWith('/Users/someone', { displayName: '~' })
    expect(link.disabled).toBe(true)
    await act(async () => finishAdd())
    expect(link.disabled).toBe(false)
  })

  it('once a project exists, Home is unchanged: no welcome', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Home reads only the repo count and kinds.
    render([{ id: 'r1', kind: 'git', path: '/p', displayName: 'p' } as Repo])
    expect(container.querySelector('[data-landing-first-run-welcome]')).toBeNull()
    expect(container.textContent).toContain('Select a workspace from the sidebar')
  })
})
