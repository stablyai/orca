import { describe, expect, it } from 'vitest'
import { notebookVenvParent } from './notebook-venv-location'

describe('notebookVenvParent', () => {
  it('uses the workspace root for a notebook inside it, else the notebook folder', () => {
    expect(notebookVenvParent('/repo/analysis/nb.ipynb', '/repo')).toBe('/repo')
    expect(notebookVenvParent('/elsewhere/nb.ipynb', '/repo')).toBe('/elsewhere')
    expect(notebookVenvParent('/repo-2/nb.ipynb', '/repo')).toBe('/repo-2')
    expect(notebookVenvParent('/repo/nb.ipynb', null)).toBe('/repo')
    expect(notebookVenvParent('C:\\repo\\a\\nb.ipynb', 'c:\\Repo')).toBe('c:\\Repo')
  })

  it('keeps the root separator for a notebook at a filesystem root', () => {
    expect(notebookVenvParent('/nb.ipynb', '/repo')).toBe('/')
    expect(notebookVenvParent('C:\\nb.ipynb', null)).toBe('C:\\')
  })
})
