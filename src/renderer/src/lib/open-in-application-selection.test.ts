import { describe, expect, it } from 'vitest'
import { getFileExplorerOpenInApplication } from './open-in-application-selection'

const zed = { id: 'zed', label: 'Zed', command: 'zed' }

describe('getFileExplorerOpenInApplication', () => {
  it('finds the chosen app and falls back to the Orca editor otherwise', () => {
    const openInApplications = [{ id: 'vscode', label: 'VS Code', command: 'code' }, zed]

    expect(
      getFileExplorerOpenInApplication({
        openInApplications,
        fileExplorerOpenInApplicationId: 'zed'
      })
    ).toBe(zed)
    expect(getFileExplorerOpenInApplication({ openInApplications })).toBeNull()
    expect(
      getFileExplorerOpenInApplication({
        openInApplications,
        fileExplorerOpenInApplicationId: null
      })
    ).toBeNull()
    expect(
      getFileExplorerOpenInApplication({
        openInApplications,
        fileExplorerOpenInApplicationId: 'removed'
      })
    ).toBeNull()
    expect(getFileExplorerOpenInApplication(null)).toBeNull()
  })
})
