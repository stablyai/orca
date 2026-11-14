import { expect } from 'vitest'
import type { ComputerSnapshotResult } from '../../../src/shared/runtime-types'
import { findRoleIndex, parseJsonOutput, runOrcaCli } from './computer-driver'

export const editableRolePattern = /^\s*(\d+)\s+(document|edit|text|pane)(?:\s|$)/im
export async function focusNotepadDocument(app: string): Promise<void> {
  const snapshot = parseJsonOutput<{ result: ComputerSnapshotResult }>(
    (
      await runOrcaCli([
        'computer',
        'get-app-state',
        '--app',
        app,
        '--restore-window',
        '--no-screenshot',
        '--json'
      ])
    ).stdout
  )
  const documentIndex = findRoleIndex(snapshot.result.snapshot.treeText, editableRolePattern)
  expect(documentIndex).toBeGreaterThanOrEqual(0)

  await runOrcaCli([
    'computer',
    'click',
    '--app',
    app,
    '--element-index',
    String(documentIndex),
    '--restore-window',
    '--no-screenshot',
    '--json'
  ])
}
