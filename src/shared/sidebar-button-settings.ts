export type SidebarButtonSettings = {
  /** Hides the Tasks sidebar button (also removes it from keyboard navigation). */
  showTasksButton: boolean
  /** Only toggles the sidebar shortcut; Home stays reachable via shortcut or command. */
  showHomeButton?: boolean
  /** Only toggles the sidebar shortcut; Automations stay reachable from Settings/View menu. */
  showAutomationsButton?: boolean
  /** Only toggles the sidebar shortcut; Artifacts stay reachable from Settings. */
  showArtifactsButton?: boolean
  /** Only toggles the sidebar shortcut; Skills stay reachable from Settings. */
  showSkillsButton?: boolean
  /** Only toggles the sidebar shortcut; Orca Mobile stays reachable from Settings. */
  showMobileButton?: boolean
}
