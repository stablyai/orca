// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { FolderLine } from './BotSkillRowParts'

afterEach(cleanup)

describe('a skills folder line', () => {
  it('opens a folder on this computer', () => {
    render(<FolderLine folder="/home/skills" hostId="local" />)
    expect(screen.getByRole('button', { name: 'Open folder' })).toBeInTheDocument()
  })

  it('offers no Open folder for a folder on a paired server', () => {
    render(<FolderLine folder="/srv/home/skills" hostId="runtime:server-1" />)
    expect(screen.getByText('/srv/home/skills')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open folder' })).toBeNull()
  })
})
