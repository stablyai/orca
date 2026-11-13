// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  loadSmartWorkspaceSourceMode,
  saveSmartWorkspaceSourceMode
} from './smart-workspace-source-mode-storage'

describe('smart workspace source mode storage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('defaults to smart when nothing is stored', () => {
    expect(loadSmartWorkspaceSourceMode()).toBe('smart')
  })

  it('restores the last chosen Branch tab', () => {
    saveSmartWorkspaceSourceMode('branches')
    expect(loadSmartWorkspaceSourceMode()).toBe('branches')
  })

  it('returns to smart after the user picks smart again', () => {
    saveSmartWorkspaceSourceMode('branches')
    saveSmartWorkspaceSourceMode('smart')
    expect(loadSmartWorkspaceSourceMode()).toBe('smart')
  })

  it('does not remember tabs that depend on async connection checks', () => {
    saveSmartWorkspaceSourceMode('branches')
    saveSmartWorkspaceSourceMode('jira')
    expect(loadSmartWorkspaceSourceMode()).toBe('branches')
  })

  it('ignores unknown stored values', () => {
    localStorage.setItem('orca.new-workspace.source-mode.v1', 'bogus')
    expect(loadSmartWorkspaceSourceMode()).toBe('smart')
  })
})
