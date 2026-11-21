/** Registered by Orca's managed OMP extension; OMP's own /vibe only runs from its TUI editor. */
export const OMP_VIBE_LAUNCH_COMMAND = 'orca-vibe'

/** Routes a launch prompt that starts with `/vibe` through the extension command. */
export function ompVibeLaunchPrompt(prompt: string): string {
  const match = /^\/vibe(?=\s|$)/.exec(prompt)
  return match ? `/${OMP_VIBE_LAUNCH_COMMAND}${prompt.slice(match[0].length)}` : prompt
}
