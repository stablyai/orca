import { describe, expect, it } from 'vitest'
import { PET_OMP_MODEL, buildPetOmpAgentArgs, petSessionDirName } from './pet-agent-spawn'

const WT = 'repo::/home/nixos/meshina'

describe('buildPetOmpAgentArgs', () => {
  it('always asks for approval', () => {
    // A pet that can open ssh endpoints and browser panels is a real actor.
    // Dropping this flag is the mutation that matters: the spawn still works,
    // it just stops asking before it acts.
    expect(buildPetOmpAgentArgs(WT)).toContain('--approval-mode always-ask')
  })

  it('pins the mesh assistant arm by default', () => {
    // Never cloud, never Ternary-Bonsai (64-76s, depth-only). If this default
    // drifts, the pet silently answers from a different model than speak-back.
    expect(buildPetOmpAgentArgs(WT)).toContain(`--model ${PET_OMP_MODEL}`)
    expect(PET_OMP_MODEL).toBe('mesh-litellm/LFM2.5-8B-A1B-Q4_0.gguf')
  })

  it('makes the session durable with a per-worktree dir and --continue', () => {
    // The two halves of durability. --continue is what resumes the thread
    // across a restart; without it every spawn starts a fresh session and the
    // "durable" claim is a lie. The dir must be inside the session-dir flag so
    // --continue looks in the pet's own dir, not omp's global default.
    const args = buildPetOmpAgentArgs(WT)
    expect(args).toMatch(/--session-dir \S*orca-pet-\S+ --continue/)
  })

  it('uses absolute session-dir and config paths (Orca quotes argv; $HOME never expands)', () => {
    // Dogfood: `$HOME/...` became `/cwd/$HOME/meshina/...` and omp failed
    // "Config overlay not found". Paths must be absolute for the host.
    const args = buildPetOmpAgentArgs(WT)
    const home = process.env.HOME ?? '/home/nixos'
    expect(args).toContain(`--session-dir ${home}/.local/state/meshina/omp-sessions/`)
    expect(args).toContain(`--config ${home}/meshina/configs/omp/mesh-coding.yml`)
    expect(args).not.toMatch(/--config\s+\$HOME/)
    expect(args).not.toMatch(/--session-dir\s+\$HOME/)
  })

  it('lets the arm be overridden without touching approval or durability', () => {
    const args = buildPetOmpAgentArgs(WT, { model: 'mesh-litellm/other.gguf' })
    expect(args).toContain('--model mesh-litellm/other.gguf')
    expect(args).toContain('--approval-mode always-ask')
    expect(args).toContain('--continue')
  })

  it('drops --continue on a fresh (rotated) spawn but keeps the same dir', () => {
    // Rotation must start a NEW session, not resume — so --continue is gone —
    // while the session-dir is unchanged so a later resume still finds it.
    const fresh = buildPetOmpAgentArgs(WT, { fresh: true })
    expect(fresh).not.toContain('--continue')
    expect(fresh).toContain('--session-dir')
    expect(fresh).toContain(petSessionDirName(WT))
  })

  it('lists only native omp tools under --tools (no MCP names)', () => {
    // Regression: cloakbrowser_browse/searxng_search in --tools made omp exit
    // with "Unknown tools in --tools". MCP loads via ~/.omp/agent/mcp.json;
    // persona may still name them.
    const args = buildPetOmpAgentArgs(WT)
    const toolsFlag = args.match(/--tools\s+(\S+)/)
    expect(toolsFlag?.[1]).toBe('read,bash,edit,write,grep,glob,todo,web_search')
    expect(toolsFlag?.[1]).not.toMatch(/cloakbrowser|searxng/)
    expect(args).toContain('cloakbrowser_browse')
    expect(args).toContain('searxng_search')
  })
})

describe('petSessionDirName', () => {
  it('is a single filesystem-safe path segment', () => {
    // worktreeIds carry `::` and `/`; a raw one would split the --session-dir
    // path and point omp at the wrong directory.
    const name = petSessionDirName(WT)
    expect(name).toMatch(/^[A-Za-z0-9._-]+$/)
    expect(name).not.toContain('/')
    expect(name).not.toContain(':')
  })

  it('is stable for one worktree so a restart resumes the same thread', () => {
    expect(petSessionDirName(WT)).toBe(petSessionDirName(WT))
  })

  it('separates worktrees that sanitize to the same prefix', () => {
    // Two ids differing only in a stripped character must not share a thread.
    expect(petSessionDirName('repo::/a/b')).not.toBe(petSessionDirName('repo::/a:b'))
  })
})
