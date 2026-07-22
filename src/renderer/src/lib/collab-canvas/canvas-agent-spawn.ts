/**
 * Panel-board omp spawn (G3) — independent agent per boardId.
 * Reuses pet mesh config / tools, but session-dir is canvas-<boardId>
 * and the default model is multimodal (board atlas is an image).
 */

import { collabCanvasSessionDirName } from '../../../../shared/collab-canvas-binding'
import type { CollabCanvasBinding } from '../../../../shared/collab-canvas-binding'
import {
  meshOmpCodingConfigPath,
  meshOmpMcpConfigDocPath,
  meshOmpSessionRoot
} from './mesh-omp-paths'

/** Multimodal default for board vision (atlas). Operator can override later. */
export const CANVAS_OMP_MODEL = 'mesh-litellm/gemma-4-12B-it-qat-UD-Q4_K_XL.gguf'

/** Native omp tools only. cloakbrowser_browse / searxng_search load via MCP
 * (`~/.omp/agent/mcp.json`), not the `--tools` allowlist (omp 17 rejects them). */
const TOOLS = 'read,bash,edit,write,grep,glob,todo,web_search'

const PERSONA = [
  'You are a collab-board agent in Orca User Panels — bound to one whiteboard,',
  'not the worktree coding terminal.',
  'You have read, bash, edit, write, grep, glob, todo, web_search,',
  'cloakbrowser_browse and searxng_search.',
  'Prefer memory/tools for durable facts when available; do not firehose.',
  'When the operator sends a board screenshot path, open it with vision.',
  'For write-back, prefer a ```collab-board JSON fence with geo/note/draft ops,',
  'or short prose that becomes an agent-draft card.',
  'Keep replies short and concrete.',
  `Mesh MCP config expected at ${meshOmpMcpConfigDocPath()} (symlink ~/.omp/agent/mcp.json).`
].join(' ')

export function canvasSessionDirName(boardId: string): string {
  const binding: CollabCanvasBinding = {
    kind: 'panel',
    panelId: 'x',
    boardId
  }
  return collabCanvasSessionDirName(binding) ?? `canvas-${boardId}`
}

export function buildCanvasOmpAgentArgs(
  boardId: string,
  options: { fresh?: boolean; model?: string } = {}
): string {
  const model = options.model ?? CANVAS_OMP_MODEL
  const sessionDir = `${meshOmpSessionRoot()}/${canvasSessionDirName(boardId)}`
  const parts = [
    '--approval-mode always-ask',
    `--model ${model}`,
    `--config ${meshOmpCodingConfigPath()}`,
    `--tools ${TOOLS}`,
    `--session-dir ${sessionDir}`,
    ...(options.fresh ? [] : ['--continue']),
    `--append-system-prompt '${PERSONA}'`
  ]
  return parts.join(' ')
}

/** In-memory boardId → agent terminal tabId (session-owned, not settings). */
const boardAgentTabIds = new Map<string, string>()

export function getCanvasBoardAgentTabId(boardId: string): string | null {
  return boardAgentTabIds.get(boardId) ?? null
}

export function setCanvasBoardAgentTabId(boardId: string, tabId: string | null): void {
  if (!tabId) {
    boardAgentTabIds.delete(boardId)
    return
  }
  boardAgentTabIds.set(boardId, tabId)
}
