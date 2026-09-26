// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SourceControlFileFilterMenu } from './file-filter-menu'

afterEach(cleanup)

/** Keeps the real dropdown controlled so clicks exercise its checkbox state transitions. */
function FilterMenuFixture({ onOpen }: { onOpen: () => void }) {
  const [extensions, setExtensions] = useState<ReadonlySet<string>>(new Set())
  const [groups, setGroups] = useState<ReadonlySet<string>>(new Set())
  return (
    <TooltipProvider>
      <SourceControlFileFilterMenu
        extensionCounts={[
          { extension: '.ts', count: 3 },
          { extension: '', count: 1 }
        ]}
        excludedExtensions={extensions}
        onExcludedExtensionsChange={setExtensions}
        fileGroups={[
          { name: 'Snapshots', patterns: ['*.snap'] },
          { name: 'Generated', patterns: ['dist/'] }
        ]}
        hiddenFileGroups={groups}
        onHiddenFileGroupsChange={setGroups}
        isFiltering={extensions.size > 0 || groups.size > 0}
        fileGroupsFailed={false}
        onOpen={onOpen}
        onReset={() => {
          setExtensions(new Set())
          setGroups(new Set())
        }}
      />
    </TooltipProvider>
  )
}

describe('source control file filter menu', () => {
  it('supports individual and all toggles, keeps the menu open, and resets the filters', async () => {
    const onOpen = vi.fn()
    render(<FilterMenuFixture onOpen={onOpen} />)
    fireEvent.keyDown(screen.getByRole('button', { name: 'Filter files by extension or group' }), {
      key: 'ArrowDown'
    })
    const allExtensions = await screen.findByRole('menuitemcheckbox', { name: 'All extensions' })
    expect(onOpen).toHaveBeenCalledOnce()
    const typescript = screen.getByRole('menuitemcheckbox', { name: '.ts 3' })
    expect(typescript).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(typescript)
    expect(typescript).toHaveAttribute('aria-checked', 'false')
    expect(allExtensions).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(allExtensions)
    expect(typescript).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(allExtensions)
    expect(screen.getByRole('menuitemcheckbox', { name: 'No extension 1' })).toHaveAttribute(
      'aria-checked',
      'false'
    )
    const allGroups = screen.getByRole('menuitemcheckbox', { name: 'All groups' })
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Snapshots' }))
    expect(allGroups).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(allGroups)
    expect(screen.getByRole('menuitemcheckbox', { name: 'Generated' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reset filters' }))
    fireEvent.keyDown(screen.getByRole('button', { name: 'Filter files by extension or group' }), {
      key: 'ArrowDown'
    })
    expect(await screen.findByRole('menuitemcheckbox', { name: 'All extensions' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    expect(screen.getByRole('menuitemcheckbox', { name: 'All groups' })).toHaveAttribute(
      'aria-checked',
      'false'
    )
  })
})
