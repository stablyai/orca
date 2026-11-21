// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { FolderLine, SkillList } from './BotSkillRowParts'

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

describe('a skill list', () => {
  it('shows every skill once Show more is pressed', () => {
    const skills = Array.from({ length: 7 }, (_, index) => ({
      id: `skill-${index + 1}`,
      name: `skill-${index + 1}`,
      description: null
    }))
    render(<SkillList skills={skills} />)
    expect(screen.queryByText('skill-7')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Show 2 more' }))

    expect(screen.getByText('skill-6')).toBeInTheDocument()
    expect(screen.getByText('skill-7')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Show .* more/ })).toBeNull()
  })
})
