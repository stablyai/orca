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
  it('points session-dir at canvas board and includes absolute mesh config', () => {
    const args = buildCanvasOmpAgentArgs('b1')
    const home = process.env.HOME ?? '/home/nixos'
    expect(args).toContain(
      `--session-dir ${home}/.local/state/meshina/omp-sessions/canvas-b1`
    )
    expect(args).toContain(`--config ${home}/meshina/configs/omp/mesh-coding.yml`)
    // Persona may still document $HOME for MCP docs; CLI flags must not.
    expect(args).not.toMatch(/--config\s+\$HOME/)
    expect(args).not.toMatch(/--session-dir\s+\$HOME/)
    expect(args).toContain('--continue')
    expect(args).toContain('gemma')
  })

  it('fresh drops --continue', () => {
    expect(buildCanvasOmpAgentArgs('b1', { fresh: true })).not.toContain('--continue')
  })

  it('lists only native omp tools under --tools (no MCP names)', () => {
    const args = buildCanvasOmpAgentArgs('b1')
    const toolsFlag = args.match(/--tools\s+(\S+)/)
    expect(toolsFlag?.[1]).toBe('read,bash,edit,write,grep,glob,todo,web_search')
    expect(toolsFlag?.[1]).not.toMatch(/cloakbrowser|searxng/)
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
