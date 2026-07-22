import { describe, expect, it } from 'vitest'
import {
  buildCanvasOmpAgentArgs,
  canvasSessionDirName,
  getCanvasBoardAgentTabId,
  setCanvasBoardAgentTabId
} from './canvas-agent-spawn'

describe('canvasSessionDirName', () => {
  it('uses canvas-<boardId>', () => {
    expect(canvasSessionDirName('board-1')).toBe('canvas-board-1')
  })
})

describe('buildCanvasOmpAgentArgs', () => {
  it('points session-dir at canvas board and includes mesh config', () => {
    const args = buildCanvasOmpAgentArgs('b1')
    expect(args).toContain('--session-dir $HOME/.local/state/meshina/omp-sessions/canvas-b1')
    expect(args).toContain('--continue')
    expect(args).toContain('mesh-coding.yml')
    expect(args).toContain('gemma')
  })

  it('fresh drops --continue', () => {
    expect(buildCanvasOmpAgentArgs('b1', { fresh: true })).not.toContain('--continue')
  })
})

describe('board agent tab binding', () => {
  it('stores and clears tab ids', () => {
    setCanvasBoardAgentTabId('b1', 'tab-9')
    expect(getCanvasBoardAgentTabId('b1')).toBe('tab-9')
    setCanvasBoardAgentTabId('b1', null)
    expect(getCanvasBoardAgentTabId('b1')).toBeNull()
  })
})
